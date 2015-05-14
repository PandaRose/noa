
var aabb = require('aabb-3d')
var vec3 = require('gl-vec3')
var extend = require('extend')
var ndarray = require('ndarray')
var inherits = require('inherits')
var EventEmitter = require('events').EventEmitter
var createContainer = require('./lib/container')
var createRendering = require('./lib/rendering')
var createWorld = require('./lib/world')
var createInputs = require('./lib/inputs')
var createPhysics = require('./lib/physics')
var createControls = require('./lib/controls')
var createRegistry = require('./lib/registry')
var createEntities = require('./lib/entities')
var raycast = require('voxel-raycast')


module.exports = Engine




var defaults = {
  playerHeight: 1.8,
  playerWidth: 0.6,
  playerStart: [0,10,0],
  playerAutoStep: false,
  tickRate: 30,

}

/*
 *    Main game engine object
 *  Emits: tick
*/

function Engine(opts) {
  if (!(this instanceof Engine)) return new Engine(opts)
  opts = extend(defaults, opts)
  this._tickRate = opts.tickRate

  // container (html/div) manager
  this.container = createContainer(this, opts)

  // inputs manager - abstracts key/mouse input
  this.inputs = createInputs(this, opts, this.container._element)

  // create block/item property registry
  this.registry = createRegistry( this, opts )

  // create world manager
  this.world = createWorld( this, opts )

  // rendering manager - abstracts all draws to 3D context
  this.rendering = createRendering(this, opts, this.container.canvas)

  // physics engine - solves collisions, properties, etc.
  this.physics = createPhysics( this, opts )

  // controls - hooks up input events to physics of player, etc.
  this.controls = createControls( this, opts )
  // accessor to let controls read/write camera rotation
  this.controls.setCameraAccessor({
    renderingRef: this.rendering,
    getRotationXY: function() {
      return this.renderingRef.getCameraRotation()
    },
    setRotationXY: function(x,y) {
      this.renderingRef.setCameraRotation(x,y)
    }
  })

  // entity manager
  this.entities = createEntities( this, opts )


  // create an entity for the player and hook up controller to its physics body
  this.playerEntity = this.entities.add(
    opts.playerStart,    // starting location- TODO: get from options
    opts.playerWidth, opts.playerHeight,
    null, null,     // no mesh, no meshOffset, 
    {}, true,       // empty data object, do physics
    true, true,     // collideTerrain, collideEntities
    true            // shadow
  )
  this.playerEntity.body.gravityMultiplier = 2 // less floaty
  this.playerEntity.body.autoStep = opts.playerAutoStep // auto step onto blocks
  if (opts.playerAutoStep) {
    this.playerEntity.body.onStep = this.entities._onPlayerAutoStep.bind(this.entities)
  }
  this.controls.setTarget( this.playerEntity.body )


  // Set up block picking functions
  this.blockTestDistance = opts.blockTestDistance || 10
  
  this._traceWorldRay = raycast.bind(null, {
    getBlock: this.world.getBlockID.bind(this.world)
  })
  
  this._traceWorldRayCollision = raycast.bind(null, {
    getBlock: this.world.getBlockSolidity.bind(this.world)
  })



  // temp hacks for development

  window.noa = this
  window.ndarray = ndarray
  window.vec3 = vec3
  var debug = false
  this.inputs.bind( 'debug', 'Z' )
  this.inputs.down.on('debug', function onDebug() {
    debug = !debug
    if (debug) window.scene.debugLayer.show(); else window.scene.debugLayer.hide();
  })


  
}

inherits( Engine, EventEmitter )


/*
 *   Core Engine API
*/ 


Engine.prototype.tick = function() {
  var dt = this._tickRate    // fixed timesteps!
  this.world.tick(dt)        // chunk creation/removal
  this.rendering.tick(dt)    // deferred remeshing of updated chunks
  this.controls.tickZoom(dt) // ticks camera zoom based on scroll events
  this.controls.tickPhysics(dt)  // applies movement forces
  this.physics.tick(dt)      // iterates physics
  this.setBlockTargets()     // finds targeted blocks, and highlights one if needed
  this.entities.tick(dt)     // tick entities and call their tick functions
  this.emit('tick', dt)
}


Engine.prototype.render = function(framePart) {
  var dt = framePart*this._tickRate // ms since last tick
  // only move camera during pointerlock or mousedown, or if pointerlock is unsupported
  if (this.container.hasPointerLock() || 
      !this.container.supportsPointerLock() || 
      this.inputs.state.fire) {
    this.controls.tickCamera()
  }
  // clear cumulative mouse inputs
  // TODO: do this, or give inputs tickMouse/tickScroll methods?
  this.inputs.state.dx = this.inputs.state.dy = 0
  // update entity meshes to account for time since last physics tick
  this.entities.updateEntitiesForRender(dt)
  // render whole scene
  this.rendering.render(dt)
}




/*
 *   Utility APIs
*/ 

Engine.prototype.getBlock = function(x, y, z) {
  var arr = (x.length) ? x : [x,y,z]
  return this.world.getBlockID( arr[0], arr[1], arr[2] );
}

Engine.prototype.setBlock = function(id, x, y, z) {
  // skips the entity collision check
  var arr = (x.length) ? x : [x,y,z]
  this.world.setBlockID( id, arr[0], arr[1], arr[2] );
}

Engine.prototype.addBlock = function(id, x, y, z) {
  // add a new terrain block, if nothing blocks the terrain there
  var arr = (x.length) ? x : [x,y,z]
  if (this.entities.isTerrainBlocked(arr[0], arr[1], arr[2])) return
  this.world.setBlockID( id, arr[0], arr[1], arr[2] );
}

Engine.prototype.getTargetBlock = function() {
  return this._blockTargetLoc
}

Engine.prototype.getTargetBlockAdjacent = function() {
  return this._blockPlacementLoc
}


Engine.prototype.getPlayerPosition = function() {
  return this.playerEntity.getPosition()
}

Engine.prototype.getPlayerEyePosition = function() {
  var height = this.playerEntity.bb.vec[1]
  var loc = this.playerEntity.getPosition()
  loc[1] += height * .9 // eyes below top of head
  return loc
}

Engine.prototype.getCameraVector = function() {
  // rendering works with babylon's xyz vectors
  var v = this.rendering.getCameraVector()
  return vec3.fromValues( v.x, v.y, v.z )
}

// Determine which block if any is targeted and within range
Engine.prototype.pick = function(pos, vec, dist) {
  if (dist===0) return null
  pos = pos || this.getPlayerEyePosition()
  vec = vec || this.getCameraVector()
  dist = dist || this.blockTestDistance
  var hitNorm = []
  var hitPos = []
  var hitBlock = this._traceWorldRayCollision(pos, vec, dist, hitPos, hitNorm)
  if (hitBlock) return {
    block: hitBlock,
    position: hitPos,
    normal: hitNorm
  }
  return null
}


// Determine which block if any is targeted and within range
// also tell rendering to highlight the struck block face
Engine.prototype.setBlockTargets = function() {
  var result = this.pick()
  // process and cache results
  if (result) {
    var loc = result.position.map(Math.floor)
    var norm = result.normal
    this._blockTargetLoc = loc
    this._blockPlacementLoc = [ loc[0]+norm[0], loc[1]+norm[1], loc[2]+norm[2] ]
    this.rendering.highlightBlockFace(true, loc, norm)
  } else {
    this._blockTargetLoc = this._blockPlacementLoc = null
    this.rendering.highlightBlockFace( false )
  }
}


// set a mesh and position offset for the player entity.
Engine.prototype.setPlayerMesh = function(mesh, meshOffset) {
  this.playerEntity.mesh = mesh
  this.playerEntity.meshOffset = meshOffset
}

/*
 *   Internals
*/ 








