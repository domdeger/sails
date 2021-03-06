/**
 * Module dependencies.
 */

var async = require('async');
var _ = require('lodash');
var util = require('util');
var __Configuration = require('./configuration');
var __initializeHooks = require('./private/loadHooks');


module.exports = function(sails) {

  var Configuration = __Configuration(sails);
  var initializeHooks = __initializeHooks(sails);

  /**
   * Expose loader start point.
   * (idempotent)
   *
   * @api public
   */

  return function load(configOverride, cb) {

    // configOverride is optional
    if (_.isFunction(configOverride)) {
      cb = configOverride;
      configOverride = {};
    }

    // Ensure override is an object and clone it (or make an empty object if it's not)
    configOverride = configOverride || {};
    sails.config = _.cloneDeep(configOverride);


    // If host is explicitly specified, set `explicitHost`
    // (otherwise when host is omitted, Express will accept all connections via INADDR_ANY)
    if (configOverride.host) {
      configOverride.explicitHost = configOverride.host;
    }


    async.auto({

      // Apply core defaults and hook-agnostic configuration,
      // esp. overrides including command-line options, environment variables,
      // and options that were passed in programmatically.
      config: [Configuration.load],

      // Load hooks into memory, with their middleware and routes
      hooks: ['config', loadHooks],

      // Populate the "registry"
      // Houses "middleware-esque" functions bound by various hooks and/or Sails core itself.
      // (i.e. `function (req, res [,next]) {}`)
      //
      // (Basically, that means we grab an exposed `middleware` object,
      // full of functions, from each hook, then make it available as
      // `sails.middleware.[HOOK_ID]`.)
      //
      // TODO: finish refactoring to change "middleware" nomenclature
      // to avoid confusion with the more specific (and more common)
      // usage of the term.
      registry: ['hooks',
        function populateRegistry(cb) {

          sails.log.verbose('Instantiating registry...');

          // Iterate through hooks and absorb the middleware therein
          // Save a reference to registry and expose it on
          // the Sails instance.
          sails.middleware = sails.registry =
          // Namespace functions by their source hook's identity
          _.reduce(sails.hooks, function(registry, hook, identity) {
            registry[identity] = hook.middleware;
            return registry;
          }, {});

          sails.emit('middleware:registered');

          cb();
        }
      ],

      // Load the router and bind routes in `sails.config.routes`
      router: ['registry', sails.router.load]

    }, ready__(cb));
  };



  /**
   * Load hooks in parallel
   * let them work out dependencies themselves,
   * taking advantage of events fired from the sails object
   *
   * @api private
   */

  function loadHooks(cb) {
    sails.hooks = {};

    // If config.hooks is disabled, skip hook loading altogether
    if (!sails.config.hooks) {
      return cb();
    }


    async.series([

      function(cb) {
        loadHookDefinitions(sails.hooks, cb);
      },
      function(cb) {
        initializeHooks(sails.hooks, cb);
      }
    ], function(err) {
      if (err) return cb(err);

      // Inform any listeners that the initial, built-in hooks
      // are finished loading
      sails.emit('hooks:builtIn:ready');
      sails.log.verbose('Built-in hooks are ready.');
      return cb();
    });
  }



  /**
   * Load built-in hook definitions from `sails.config.hooks`
   * and put them back into `hooks` (probably `sails.hooks`)
   *
   * @api private
   */

  function loadHookDefinitions(hooks, cb) {

    // Mix in user-configured hook definitions
    _.extend(hooks, sails.config.hooks);

    // Make sure these changes to the hooks object get applied
    // to sails.config.hooks to keep logic consistent
    // (I think we can get away w/o this, but leaving as a stub)
    // sails.config.hooks = hooks;

    // If user configured `loadHooks`, only include those.
    if (sails.config.loadHooks) {
      if (!_.isArray(sails.config.loadHooks)) {
        return cb('Invalid `loadHooks` config.  ' +
          'Please specify an array of string hook names.\n' +
          'You specified ::' + util.inspect(sails.config.loadHooks));
      }

      _.each(hooks, function(def, hookName) {
        if (!_.contains(sails.config.loadHooks, hookName)) {
          hooks[hookName] = false;
        }
      });
      sails.log.verbose('Deliberate partial load-- will only initialize hooks ::', sails.config.loadHooks);
    }

    return cb();
  }


  /**
   * Returns function which is fired when Sails is ready to go
   *
   * @api private
   */

  function ready__(cb) {
    return function(err) {
      if (err) {
        // sails.log.error('Sails encountered the following error:');
        sails.log.error(err);
        return cb && cb(err);
      }

      // Wait until all hooks are ready
      sails.log.verbose('Waiting for all hooks to declare that they\'re ready...');
      var hookTimeout = setTimeout(function tooLong() {
        var hooksTookTooLongErr = 'Hooks are taking way too long to get ready...  ' +
          'Something is amiss.\nAre you using any custom hooks?\nIf so, make sure the hook\'s ' +
          '`initialize()` method is triggering it\'s callback.';
        sails.log.error(hooksTookTooLongErr);
        process.exit(1);
      }, 10000);

      async.whilst(
        function checkIfAllHooksAreReady() {
          return _.any(sails.hooks, function(hook) {
            return !hook.ready;
          });
        },
        function waitABit(whilst_cb) {
          setTimeout(whilst_cb, 150);
        },
        function hooksLoaded(err) {
          clearTimeout(hookTimeout);
          if (err) {
            var msg = 'Error loading hooks.';
            sails.log.error(msg);
            return cb && cb(msg);
          }

          sails.log.verbose('All hooks were loaded successfully.');

          // Optionally expose services, models, sails, _, async, etc. as globals
          sails.exposeGlobals();

          cb && cb(null, sails);
        }
      );
    };
  }
};
