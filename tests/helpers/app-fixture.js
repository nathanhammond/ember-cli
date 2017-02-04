'use strict';

const fs = require('fs-extra');
const path = require('path');
const symlinkOrCopySync = require('symlink-or-copy').sync;
const merge = require('ember-cli-lodash-subset').merge;

const fixturify = require('fixturify');
const quickTemp = require('quick-temp');

const originalWorkingDirectory = process.cwd();
const root = path.resolve(__dirname, '..', '..');

const PackageCache = require('../../tests/helpers/package-cache');
const CommandGenerator = require('../../tests/helpers/command-generator');

/**
 * The `ember` command helper.
 *
 * @method ember
 * @param {String} subcommand The subcommand to be passed into ember.
 * @param {String} [...arguments] Arguments to be passed into the ember subcommand.
 * @param {Object} [options={}] The options passed into child_process.spawnSync.
 *   (https://nodejs.org/api/child_process.html#child_process_child_process_spawnsync_command_args_options)
 */
const ember = new CommandGenerator(path.join(root, 'bin', 'ember'));

/**
 * AppFixture is designed to make it easy to mock up a complete Ember project.
 * You would use it inside of an addon in order to write complex tests which
 * cannot be achieved using just the dummy application. It enables testing of
 * interactions between multiple addons and provides useful utility functions
 * for interacting with the fixture.
 *
 * The primary need for `AppFixture` is to be able to quickly, repeatably,
 * maintainably, and in an understandable manner create complex fixtures.
 * Meeting these ergonomic goals makes it possible to cover all of the
 * permutations you will need to test. Prior to this we have numerous
 * examples of fixtures which did not cover all edge cases as creating and
 * maintaining them was too tedious, expensive, and complicated.
 *
 * These fixtures must also be aware of their performance impact so
 * consolidating on a single pattern and approach enables us to focus our
 * performance efforts in one place.
 *
 * In typical use cases AppFixture will be used in a testing context where you
 * generate the fixture in `before` and then clean up in `after`.
 *
 * Usage:
 *
 * ```
 * const fs = require('fs');
 * const path = require('path');
 * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
 *
 * const CommandGenerator = require('ember-cli/tests/helpers/command-generator');
 * const ember = new CommandGenerator(require.resolve('ember-cli/bin/ember'));
 *
 * let root = new AppFixture('name');
 * root.serialize();
 *
 * let result = ember.invoke('build', { cwd: root.dir });
 * let appJSPath = path.join(root.dir, 'dist', 'assets', `${root.name}.js`);
 * let appJS = fs.readFileSync(appJSPath, { encoding: 'utf8' });
 *
 * if (appJS.indexOf('some search string') === -1) {
 *   throw new Error('Something went wrong.');
 * }
 *
 * root.clean();
 * ```
 *
 * This generates a fixture by invoking `ember new app-name`. This will use the
 * version of Ember CLI which is installed in the consuming project. For
 * example, if you are developing an addon and have ember-cli@2.9.1 as the
 * version specified in your `package.json` the fixtures generated by AppFixture
 * will use the blueprint from Ember CLI 2.9.1.
 *
 * An AppFixture has two properties of note:
 *
 * - `_dir`: A read-only property on the prototype specifying the place on disk
 *   where the fixture will live after serialization. Has a getter at `.dir` on
 *   the prototype.
 * - `fixture`: JSON specifying the structure of the project in the format
 *   specified by [`fixturify`](https://github.com/joliss/node-fixturify).
 *
 * You may directly modify the contents of the `fixture` property, however,
 * AppFixture provides some convenience methods to make it easier to accomplish.
 *
 * @class AppFixture
 * @constructor
 * @param {String} name app name as you would pass to `ember new ____`.
 */
function AppFixture(name) {
  this.type = 'app';
  this.command = 'new';
  this.name = name;
  this._installedAddonFixtures = [];
  this.serialized = false;

  this._init();
}

AppFixture.prototype = {

  /**
   * Completes the setup process. Split out into a separate function so that
   * subclasses can reuse larger chunks of code.
   *
   * @method _init
   */
  _init() {
    process.chdir(root);
    let dirName = `${this.name}-${this.type}-fixture`;
    this._dir = quickTemp.makeOrRemake({}, dirName);
    process.chdir(originalWorkingDirectory);

    this._loadBlueprint();
  },

  /**
   * Invokes the appropriate `ember` command to create a fixture. Does this
   * using `execa` to guarantee that it matches the output of a real app or
   * addon. It then reads that output via `fixturify` and sets the `fixture`
   * property. This runs during the constructor.
   *
   * Does _not_ cache as it makes no assumptions as to how the invoked command
   * functions. This is overly-pessimistic, but guaranteed to be correct.
   *
   * @method _loadBlueprint
   */
  _loadBlueprint() {
    fs.emptyDirSync(this.dir);

    ember.invoke(
      this.command,
      this.name,
      `--directory=${this.dir}`,
      '--disable-analytics',
      '--watcher=node',
      '--skip-npm',
      '--skip-bower',
      '--skip-git'
    );

    var handler = {
      set: function(target, property, value) {
        target.serialized = false;
        target[property] = value;
        return true;
      },
      deleteProperty: function(target, property) {
        target.serialized = false;
        delete target[property];
        return true;
      }
    };

    this.fixture = new Proxy(fixturify.readSync(this.dir), handler);

    // Clean up after the generator.
    fs.emptyDirSync(this.dir);
  },

  /**
   * If you call `serialize` on an `AppFixture` it will depth-first materialize
   * itself and set up its `PackageCache`. This guarantees that the assets will
   * be present by the time they're needed by any parents. `serialize` is also
   * completely idempotent. Invoking `serialize` multiple times will perform no
   * unnecessary work and will always guarantee consistency. This is designed
   * to make usage inside of a test suite's `beforeEach` hook ergonomic.
   *
   * For example, given this code:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   *
   * let root = new AppFixture('root');
   * let child = new InRepoAddonFixture('child');
   * let grandchild = new InRepoAddonFixture('grandchild');
   * let greatgrandchild = new InRepoAddonFixture('greatgrandchild');
   *
   * child.installAddonFixture(grandchild);
   * root.installAddonFixture(child);
   * grandchild.installAddonFixture(greatgrandchild);
   *
   * root.serialize();
   *
   * child.generateFile('something.js', 'console.log("Hello, world!");');
   * root.serialize();
   * ```
   *
   * 1. Each of the `AppFixture`/`InRepoAddonFixture`s are created but not
   *    materialized.
   * 2. All of the fixtures are symlinked together. The code example is
   *    intentionally done in a screwball order to demonstrate that _order does
   *    not matter_.
   * 3. Serialization occurs. The order of serialization is the depth-first
   *    resolution of the graph you've generated. It does not do a topsort of a
   *    DAG as that is believed to be unnecessary. In this case the order is:
   *    `greatgrandchild`, `grandchild`, `child`, `root`.
   * 4. Each of those assets are symlinked together making them composable
   *    primitives which can be used across test runs. They will not be
   *    regenerated unless the fixture itself has changed.
   * 5. The second `serialize` call will walk the `Fixture`s depth-first,
   *    identify that only `child` needs to change, regenerate that fixture, and
   *    return without any additional file I/O.
   *
   * @method serialize
   * @param {Boolean} _isChild Private. Enables smarter dependency installation.
   */
  serialize(_isChild) {
    // Short-circuit abort for a clean fixture.
    if (this.serialized) {
      return this;
    }

    // Default link in ember-cli.
    // This is required in order to be able to use these helpers in Ember CLI.
    // Possibly move this to a public API in the future.
    let npmLinks = [{
      name: 'ember-cli',
      path: root,
    }];

    let inRepoLinks = [];
    let self = this;
    this._installedAddonFixtures.forEach(function(addon) {

      // This triggers the depth-first handling.
      addon.serialize(true);

      if (addon.type === 'addon') {
        /*
        This leverages `PackageCache`s imitation `npm link` behavior.
        It is provided by `PackageCache` as "best effort." To debug this start
        by reviewing the symlinks in the ouput fixture directory.

        Note: you _must_ use the `PackageCache` linking behavior here. Do _not_
        manually attempt to symlink things inside of the `node_modules` folder
        as that _will_ end up trolling yourself and your test suite.
        */
        npmLinks.push({
          name: addon.name,
          path: addon.dir,
        });
      } else if (addon.type === 'in-repo-addon') {
        /*
        These links are managed and maintained by `AppFixture`.
        We are intentionally _not_ using path traversal via `path.resolve()`
        to generate relative paths between these addons and setting up a
        symlink instead to:

        1. Be more consistent with typical usage patterns.
        2. Make it easier to identify and uninstall an addon from the `paths`
           property inside of `package.json`.
        */
        inRepoLinks.push({
          from: path.join(self.dir, 'lib', addon.name),
          to: addon.dir,
        });
      } else {
        throw new Error('Cannot serialize addon.');
      }
    });

    fixturify.writeSync(this.dir, this.fixture);

    let packageCache = new PackageCache(root);

    let from, to;
    if (this.fixture['package.json'] || npmLinks.length) {
      let nodePackageCache;
      /*
      So, let's say you're trying to make your installation faster. It turns out
      that our default blueprints include _tons_ of `devDependencies`. Because
      of the node module installation pattern (only installs `devDependencies`
      of the item being installed, not its dependencies) we can short-circuit a
      lot of install time and disk I/O by simply forcing the package manager
      into `production` mode and skip the `devDependencies` altogether.

      We still have to account for the possiblity that something gets
      re-serialized in a non-child state, so we must identify which cache to
      use when linking.
      */
      if (_isChild) {
        process.env.NODE_ENV = 'production';
        let cacheName = `${this.type}-production-node`;
        nodePackageCache = packageCache.create(cacheName, 'yarn', this.fixture['package.json'], npmLinks);
        delete process.env.NODE_ENV;
      } else {
        let cacheName = `${this.type}-node`;
        nodePackageCache = packageCache.create(cacheName, 'yarn', this.fixture['package.json'], npmLinks);
      }

      // Symlink the `PackageCache` into the fixture directory.
      from = path.join(nodePackageCache, 'node_modules');
      fs.mkdirsSync(from); // Just in case the path doesn't exist.
      to = path.join(this.dir, 'node_modules');
      symlinkOrCopySync(from, to);
    }

    /*
    Given that:
    - The default blueprints no longer have `bower` dependencies.
    - We've never had a `bower` dependency in `devDependencies`.
    - There is no nesting.

    We therefore do not perform the `_isChild` ceremony for `bower`.
    */
    if (!_isChild && this.fixture['bower.json']) {
      let cacheName = `${this.type}-bower`;
      let bowerPackageCache = packageCache.create(cacheName, 'bower', this.fixture['bower.json']);

      // Symlink the `PackageCache` into the fixture directory.
      from = path.join(bowerPackageCache, 'bower_components');
      fs.mkdirsSync(from); // Just in case the path doesn't exist.
      to = path.join(this.dir, 'bower_components');
      symlinkOrCopySync(from, to);
    }

    inRepoLinks.forEach(function(link) {
      fs.mkdirsSync(path.dirname(link.from)); // Just in case the path doesn't exist.
      fs.mkdirsSync(path.dirname(link.to)); // Just in case the path doesn't exist.
      symlinkOrCopySync(link.to, link.from);
    });

    this.serialized = true;
    return this;
  },

  /**
   * The `clean` method on an `AppFixture` removes the serialized assets from
   * disk. This is a destructive command and should likely only be used at the
   * very end of the test suite as calling `serialize` will do the minimum work
   * necessary in order to update the fixture.
   *
   * For parallel behavior it does a depth-first `clean` of all `Fixture`s
   * descending from it.
   *
   * @method clean
   */
  clean() {
    this._installedAddonFixtures.forEach(function(addon) {
      // This triggers the depth-first handling.
      addon.clean(true);
    });

    // Build up object to pass to quickTemp. The API needs some work for this
    // use case: https://github.com/joliss/node-quick-temp/pull/16
    let dir = {};
    let dirName = `${this.name}-${this.type}-fixture`;
    dir[dirName] = this.dir;

    process.chdir(root);
    quickTemp.remove(dir, dirName);
    process.chdir(originalWorkingDirectory);

    return this;
  },

  /**
   * `installNodeModule` is a convenience method around making modifications to
   * `package.json` inside of the fixture. It adds a dependency to the file but
   * does not do so by invoking `npm install` or `yarn add`.
   *
   * Usage:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   * let root = new AppFixture('root');
   * root.installNodeModule('dependencies', 'left-pad', '*');
   * root.serialize();
   * ```
   *
   * @method installNodeModule
   * @param {String} key Which key to add the node module to, e.g. `dependencies`.
   * @param {String} name The name of the node module.
   * @param {String} version The `package.json` compatible version identifier.
   */
  installNodeModule(key, name, version) {
    version = version || '*';

    let config = this.getPackageJSON();

    config[key] = config[key] || {};
    config[key][name] = version;

    this.setPackageJSON(config);
    return this;
  },

  /**
   * `uninstallNodeModule` is a convenience method around making modifications
   * to `package.json` inside of the fixture. It removes the specified
   * dependency from the passed in key.
   *
   * Usage:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   * let root = new AppFixture('root');
   * root.uninstallNodeModule('dependencies', 'ember-welcome-page');
   * root.serialize();
   * ```
   *
   * @method uninstallNodeModule
   * @param {String} key Which key to remove the node module from, e.g. `dependencies`.
   * @param {String} name The name of the node module.
   */
  uninstallNodeModule(key, name) {
    let config = this.getPackageJSON();

    if (config[key] && config[key][name]) {
      delete config[key][name];
    }

    this.setPackageJSON(config);
    return this;
  },

  /**
   * `installAddonFixture` handles the entire setup for installing (and
   * linking) an `AddonFixture`. It delegates to the type-specific
   * `AddonFixture` installation process.
   *
   * Usage:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   * const AddonFixture = require.resolve('ember-cli/tests/helpers/addon-fixture');
   * let root = new AppFixture('root');
   * let child = new AddonFixture('child');
   * root.installAddonFixture(child);
   * root.serialize();
   * ```
   *
   * @method installAddonFixture
   * @param {AddonFixture} addon The addon which you wish to install.
   */
  installAddonFixture(addon) {
    this._installedAddonFixtures.push(addon);

    if (addon.type === 'addon') {
      return this._npmAddonFixtureInstall(addon);
    }

    if (addon.type === 'in-repo-addon') {
      return this._inRepoAddonFixtureInstall(addon);
    }

    throw new Error('Cannot install addon.');
  },

  /**
   * Handles node module installation for a fixture. Delegates to
   * `installNodeModule`. Reference is captured in `installAddonFixture` for
   * proper serialization.
   *
   * @private
   * @method _npmAddonFixtureInstall
   * @param {AddonFixture} addon The addon which you wish to install.
   */
  _npmAddonFixtureInstall(addon) {
    return this.installNodeModule('dependencies', addon.name);
  },

  /**
   * Handles Ember Addon installation for a fixture. Adds the `path` to
   * the `ember-addon` object.
   *
   * @private
   * @method _inRepoAddonFixtureInstall
   * @param {AddonFixture} addon The addon which you wish to install.
   */
  _inRepoAddonFixtureInstall(addon) {
    let config = this.getPackageJSON();

    config['ember-addon'] = config['ember-addon'] || {};
    config['ember-addon']['paths'] = config['ember-addon']['paths'] || [];
    config['ember-addon'].paths.push(`lib/${addon.name}`);

    this.setPackageJSON(config);
    return this;
  },

  /**
   * `uninstallAddonFixture` removes a previously installed addon fixture from
   * the `AppFixture`. It delegates to the type-specific `AddonFixture`
   * uninstallation methods.
   *
   * Usage:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   * const AddonFixture = require.resolve('ember-cli/tests/helpers/addon-fixture');
   * let root = new AppFixture('root');
   * let child = new AddonFixture('child');
   * root.serialize();
   *
   * // Perform some test.
   *
   * root.uninstallAddonFixture(child);
   * root.serialize();
   * ```
   *
   * @method uninstallAddonFixture
   * @param {AddonFixture} addon The addon which you wish to uninstall.
   */
  uninstallAddonFixture(addon) {
    let needle = addon;
    let haystack = this._installedAddonFixtures;

    if (haystack.indexOf(needle) !== -1) {
      this._installedAddonFixtures.splice(haystack.indexOf(needle), 1);
    }

    if (addon.type === 'addon') {
      return this._npmAddonFixtureUninstall(addon);
    }

    if (addon.type === 'in-repo-addon') {
      return this._inRepoAddonFixtureUninstall(addon);
    }

    throw new Error('Cannot uninstall addon.');
  },

  /**
   * Handles node module uninstallation for a fixture. Delegates to
   * `uninstallNodeModule`. Reference is removed in `uninstallAddonFixture` for
   * proper serialization.
   *
   * @private
   * @method _npmAddonFixtureUninstall
   * @param {AddonFixture} addon The addon which you wish to uninstall.
   */
  _npmAddonFixtureUninstall(addon) {
    return this.uninstallNodeModule('dependencies', addon.name);
  },

  /**
   * Handles Ember Addon uninstallation for a fixture. Removes the `path` to
   * the `ember-addon` object.
   *
   * @private
   * @method _inRepoAddonFixtureInstall
   * @param {AddonFixture} addon The addon which you wish to uninstall.
   */
  _inRepoAddonFixtureUninstall(addon) {
    let config = this.getPackageJSON();

    let needle = `lib/${addon.name}`;
    let haystack = config['ember-addon']['paths'];

    if (haystack.indexOf(needle) !== -1) {
      config['ember-addon']['paths'].splice(haystack.indexOf(needle), 1);
    }

    this.setPackageJSON(config);
    return this;
  },

  /**
   * Convenience method to get the `AppFixture`'s `package.json` file and
   * return it as a parsed JSON object.
   *
   * @method getPackageJSON
   */
  getPackageJSON() {
    return JSON.parse(this.fixture['package.json']);
  },

  /**
   * Convenience method to set the `AppFixture`'s `package.json` to the
   * `JSON.stringify` of the passed in object.
   *
   * @method getPackageJSON
   * @param {Object} value The JSON object to serialize into `package.json`.
   */
  setPackageJSON(value) {
    return this.fixture['package.json'] = JSON.stringify(value);
  },

  /**
   * The `generate` series of methods are used to create the pattern and
   * structure in tests that make it easy to understand what has been added
   * to a fixture. `generateFile` is the generic version which many other
   * `generate` functions delegate to.
   *
   * Usage:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   * let root = new AppFixture('root');
   * root.generateFile('app/templates/index.hbs', 'Hello, world!');
   * root.serialize();
   * ```
   *
   * @method generateFile
   * @param {String} fileName The _POSIX_ path of the file to create.
   * @param {String} contents The contents of that file.
   */
  generateFile(fileName, contents) {
    fileName = fileName.replace(/^\//, '');
    let keyPath = fileName.split('/');

    // Build up the object structure that matches the shape needed by
    // `fixturify`. We do this seperately and then `merge` it with the existing
    // object.
    let root = {};
    let cursor = root;
    let i = 0;
    for (i = 0; i < keyPath.length - 1; i++) {
      cursor = cursor[keyPath[i]] = {};
    }

    // Note that we are using the index from the iterator outside of the loop.
    cursor[keyPath[i]] = contents;

    merge(this.fixture, root);
    return this;
  },

  /**
   * The `generateCSS` method generates a (valid) default CSS pattern which you
   * can look for in the output of a build. Useful when you don't care about the
   * contents and instead just want to find a marker in the output.
   *
   * Usage:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   * let root = new AppFixture('root');
   * root.generateCSS('app/styles/app.css');
   * root.serialize();
   * ```
   *
   * @method generateCSS
   * @param {String} fileName The _POSIX_ path of the file to create.
   */
  generateCSS(fileName) {
    let contents = `.${this.name} { content: "${fileName}"; }`;
    return this.generateFile(fileName, contents);
  },

  /**
   * The `generateJS` method generates a (valid) default JS pattern which you
   * can look for in the output of a build. Useful when you don't care about the
   * contents and instead just want to find a marker in the output.
   *
   * Usage:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   * let root = new AppFixture('root');
   * root.generateJS('app/components/thing-one.js');
   * root.serialize();
   * ```
   *
   * @method generateCSS
   * @param {String} fileName The _POSIX_ path of the file to create.
   */
  generateJS(fileName) {
    let contents = `// ${this.name}/${fileName}\nlet a = true;`;
    return this.generateFile(fileName, contents);
  },

  /**
   * The `generateTemplate` method generates a (valid) default template pattern
   * which you can look for in the output of a build. Useful when you don't care
   * about the contents and instead just want to find a marker in the output.
   *
   * Usage:
   *
   * ```
   * const AppFixture = require.resolve('ember-cli/tests/helpers/app-fixture');
   * let root = new AppFixture('root');
   * root.generateTemplate('app/templates/index.hbs');
   * root.serialize();
   * ```
   *
   * @method generateTemplate
   * @param {String} fileName The _POSIX_ path of the file to create.
   */
  generateTemplate(fileName) {
    let contents = `{{${this.name}}}`;
    return this.generateFile(fileName, contents);
  },
};


/**
 * A read-only property on the prototype specifying the place on disk
 * where the fixture will live after serialization.
 * @property dir
 */
Object.defineProperty(AppFixture.prototype, 'dir', {
  get() {
    return this._dir;
  },
});

module.exports = AppFixture;
