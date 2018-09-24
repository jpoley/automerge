const { OPTIONS, CACHE, INBOUND, STATE, OBJECT_ID, CONFLICTS, CHANGE, ELEM_IDS } = require('./constants')
const { ROOT_ID, isObject } = require('../src/common')
const uuid = require('../src/uuid')
const { applyDiffs, updateParentObjects, cloneRootObject } = require('./apply_patch')
const { rootObjectProxy } = require('./proxies')
const { Context } = require('./context')
const { Text } = require('./text')

/**
 * Takes a set of objects that have been updated (in `updated`) and an updated
 * mapping from child objectId to parent objectId (in `inbound`), and returns
 * a new immutable document root object based on `doc` that reflects those
 * updates. The state object `state` is attached to the new root object.
 */
function updateRootObject(doc, updated, inbound, state) {
  let newDoc = updated[ROOT_ID]
  if (!newDoc) {
    newDoc = cloneRootObject(doc[CACHE][ROOT_ID])
    updated[ROOT_ID] = newDoc
  }
  Object.defineProperty(newDoc, '_actorId', {value: doc[OPTIONS].actorId})
  Object.defineProperty(newDoc, OPTIONS,  {value: doc[OPTIONS]})
  Object.defineProperty(newDoc, CACHE,    {value: updated})
  Object.defineProperty(newDoc, INBOUND,  {value: inbound})
  Object.defineProperty(newDoc, STATE,    {value: state})

  for (let objectId of Object.keys(doc[CACHE])) {
    if (updated[objectId]) {
      Object.freeze(updated[objectId])
      Object.freeze(updated[objectId][CONFLICTS])
    } else {
      updated[objectId] = doc[CACHE][objectId]
    }
  }

  Object.freeze(updated)
  Object.freeze(inbound)
  return newDoc
}

/**
 * Filters a list of operations `ops` such that, if there are multiple assignment
 * operations for the same object and key, we keep only the most recent. Returns
 * the filtered list of operations.
 */
function ensureSingleAssignment(ops) {
  let assignments = {}, result = []

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i], { obj, key, action } = op
    if (['set', 'del', 'link'].includes(action)) {
      if (!assignments[obj]) {
        assignments[obj] = {[key]: true}
        result.push(op)
      } else if (!assignments[obj][key]) {
        assignments[obj][key] = true
        result.push(op)
      }
    } else {
      result.push(op)
    }
  }
  return result.reverse()
}

/**
 * Adds a new change request to the list of pending requests, and returns an
 * updated document root object. The details of the change are taken from the
 * context object `context`, and `message` is an optional human-readable string
 * describing the change.
 */
function makeChange(doc, context, message) {
  const actor = doc[OPTIONS].actorId
  const state = Object.assign({}, doc[STATE])
  state.seq += 1
  const deps = Object.assign({}, state.deps)
  delete deps[actor]

  const ops = ensureSingleAssignment(context.ops)

  if (doc[OPTIONS].backend) {
    const request = {actor, seq: state.seq, deps, message, ops}
    const [backendState, patch] = doc[OPTIONS].backend.applyChange(state.backendState, request)
    state.deps = patch.deps
    state.backendState = backendState
    state.requests = []
    return applyPatchToDoc(doc, patch, state)

  } else {
    const request = {actor, seq: state.seq, deps, message, before: doc, ops, diffs: context.diffs}
    state.requests = state.requests.slice() // shallow clone
    state.requests.push(request)
    return updateRootObject(doc, context.updated, context.inbound, state)
  }
}

/**
 * Applies the changes described in `patch` to the document with root object
 * `doc`. The state object `state` is attached to the new root object.
 */
function applyPatchToDoc(doc, patch, state) {
  let inbound = Object.assign({}, doc[INBOUND])
  let updated = {}
  applyDiffs(patch.diffs, doc[CACHE], updated, inbound)
  updateParentObjects(doc[CACHE], updated, inbound)
  return updateRootObject(doc, updated, inbound, state)
}

/**
 * Mutates the request object `request` (representing a change made locally but
 * not yet applied by the backend), transforming it past the remote `patch`.
 * The transformed version of `request` can be applied after `patch` has been
 * applied, and its effect is the same as when the original version of `request`
 * is applied to the base document without `patch`.
 *
 * This function implements a simple form of Operational Transformation.
 * However, the implementation here is actually incomplete and incorrect.
 * Fortunately, it's actually not a big problem if the transformation here is
 * not quite right, because the transformed request is only used transiently
 * while waiting for a response from the backend. When the backend responds, the
 * transformation result is discarded and replaced with the backend's version.
 *
 * One scenario that is not handled correctly is insertion at the same index:
 * request = {diffs: [{obj: someList, type: 'list', action: 'insert', index: 1}]}
 * patch = {diffs: [{obj: someList, type: 'list', action: 'insert', index: 1}]}
 *
 * Correct behaviour (i.e. consistent with the CRDT) would be to order the two
 * insertions by their elemIds; any subsequent insertions with consecutive
 * indexes may also need to be adjusted accordingly (to keep an insertion
 * sequence by a particular actor uninterrupted).
 *
 * Another scenario that is not handled correctly:
 * requests = [
 *   {diffs: [{obj: someList, type: 'list', action: 'insert', index: 1, value: 'a'}]},
 *   {diffs: [{obj: someList, type: 'list', action: 'set',    index: 1, value: 'b'}]}
 * ]
 * patch = {diffs: [{obj: someList, type: 'list', action: 'remove', index: 1}]}
 *
 * The first request's insertion is correctly left unchanged, but the 'set' action
 * is incorrectly turned into an 'insert' because we don't realise that it is
 * assigning the previously inserted list item (not the deleted item).
 *
 * A third scenario is concurrent assignment to the same list element or map key;
 * this should create a conflict.
 */
function transformRequest(request, patch) {
  let transformed = []

  local_loop:
  for (let local of request.diffs) {
    local = Object.assign({}, local)

    for (let remote of patch.diffs) {
      // If the incoming patch modifies list indexes (because it inserts or removes),
      // adjust the indexes in local diffs accordingly
      if (local.obj === remote.obj && local.type === 'list' &&
          ['insert', 'set', 'remove'].includes(local.action)) {
        if (remote.action === 'insert' && remote.index <=  local.index) local.index += 1
        if (remote.action === 'remove' && remote.index <   local.index) local.index -= 1
        if (remote.action === 'remove' && remote.index === local.index) {
          if (local.action === 'set') local.action = 'insert'
          if (local.action === 'remove') continue local_loop // drop this diff
        }
      }
    }
    transformed.push(local)
  }

  request.diffs = transformed
}

/**
 * Creates an empty document object with no changes.
 */
function init(options) {
  if (typeof options === 'string') {
    options = {actorId: options}
  } else if (typeof options === 'undefined') {
    options = {}
  } else if (!isObject(options)) {
    throw new TypeError(`Unsupported value for init() options: ${options}`)
  }
  if (options.actorId === undefined) {
    options.actorId = uuid()
  }

  const root = {}, cache = {[ROOT_ID]: root}
  const state = {seq: 0, requests: [], deps: {}}
  if (options.backend) {
    state.backendState = options.backend.init(options.actorId)
  }
  Object.defineProperty(root, '_actorId', {value: options.actorId})
  Object.defineProperty(root, OBJECT_ID, {value: ROOT_ID})
  Object.defineProperty(root, OPTIONS,   {value: Object.freeze(options)})
  Object.defineProperty(root, CONFLICTS, {value: Object.freeze({})})
  Object.defineProperty(root, CACHE,     {value: Object.freeze(cache)})
  Object.defineProperty(root, INBOUND,   {value: Object.freeze({})})
  Object.defineProperty(root, STATE,     {value: Object.freeze(state)})
  return Object.freeze(root)
}

/**
 * Changes a document `doc` according to actions taken by the local user.
 * `message` is an optional descriptive string that is attached to the change.
 * The actual change is made within the callback function `callback`, which is
 * given a mutable version of the document as argument.
 */
function change(doc, message, callback) {
  if (doc[OBJECT_ID] !== ROOT_ID) {
    throw new TypeError('The first argument to Automerge.change must be the document root')
  }
  if (doc[CHANGE]) {
    throw new TypeError('Calls to Automerge.change cannot be nested')
  }
  if (typeof message === 'function' && callback === undefined) {
    ;[message, callback] = [callback, message]
  }
  if (message !== undefined && typeof message !== 'string') {
    throw new TypeError('Change message must be a string')
  }

  let context = new Context(doc)
  callback(rootObjectProxy(context))

  if (Object.keys(context.updated).length === 0) {
    // If the callback didn't change anything, return the original document object unchanged
    return doc
  } else {
    updateParentObjects(doc[CACHE], context.updated, context.inbound)
    return makeChange(doc, context, message)
  }
}

/**
 * Triggers a new change request on the document `doc` without actually
 * modifying its data. `message` is an optional descriptive string attached to
 * the change. This function can be useful for acknowledging the receipt of
 * some message (as it's incorported into the `deps` field of the change).
 */
function emptyChange(doc, message) {
  if (message !== undefined && typeof message !== 'string') {
    throw new TypeError('Change message must be a string')
  }
  return makeChange(doc, new Context(doc), message)
}

/**
 * Applies `patch` to the document root object `doc`. This patch must come
 * from the backend; it may be the result of a local change or a remote change.
 * If it is the result of a local change, the `seq` field from the change
 * request should be included in the patch, so that we can match them up here.
 */
function applyPatch(doc, patch) {
  const actor = doc[OPTIONS].actorId
  const deps = patch.deps || {}
  const state = Object.assign({}, doc[STATE])
  let baseDoc
  if (state.requests.length > 0) {
    if (patch.actor === getActorId(doc) && patch.seq !== undefined) {
      if (state.requests[0].seq !== patch.seq) {
        throw new RangeError(`Mismatched sequence number: patch ${patch.seq} does not match next request ${state.requests[0].seq}`)
      }
      baseDoc = state.requests[0].before
      state.requests = state.requests.slice(1).map(req => Object.assign({}, req))
    } else {
      baseDoc = state.requests[0].before
      state.requests = state.requests.slice().map(req => Object.assign({}, req))
    }
  } else {
    baseDoc = doc
    state.requests = []
  }

  state.deps = deps
  if (deps[actor] && deps[actor] > state.seq) {
    state.seq = deps[actor]
  }

  if (doc[OPTIONS].backend) {
    if (!patch.state) {
      throw new RangeError('When an immediate backend is used, a patch must contain the new backend state')
    }
    state.backendState = patch.state
    state.requests = []
    return applyPatchToDoc(doc, patch, state)
  }

  let newDoc = applyPatchToDoc(baseDoc, patch, state)
  for (let request of state.requests) {
    request.before = newDoc
    transformRequest(request, patch)
    newDoc = applyPatchToDoc(request.before, request, state)
  }
  return newDoc
}

/**
 * Returns the Automerge object ID of the given object.
 */
function getObjectId(object) {
  return object[OBJECT_ID]
}

/**
 * Returns the Automerge actor ID of the given document.
 */
function getActorId(doc) {
  return doc[OPTIONS].actorId
}

/**
 * Fetches the conflicts on `object`, which may be any object in a document.
 * If the object is a map, returns an object mapping keys to conflict sets
 * (only for those keys that actually have conflicts). If the object is a list,
 * returns a list that contains null for non-conflicting indexes and a conflict
 * set otherwise.
 */
function getConflicts(object) {
  return object[CONFLICTS]
}

/**
 * Returns the list of change requests pending on the document `doc`.
 */
function getRequests(doc) {
  return doc[STATE].requests.map(req => {
    const { actor, seq, deps, message, ops } = req
    const change = { actor, seq, deps }
    if (message !== undefined) {
      change.message = message
    }
    change.ops = ops
    return change
  })
}

/**
 * Returns the backend state associated with the document `doc` (only used if
 * a backend implementation is passed to `init()`).
 */
function getBackendState(doc) {
  return doc[STATE].backendState
}

function getElementIds(list) {
  return list[ELEM_IDS]
}

module.exports = {
  init, change, emptyChange, applyPatch,
  getObjectId, getActorId, getConflicts, getRequests, getBackendState, getElementIds,
  Text
}
