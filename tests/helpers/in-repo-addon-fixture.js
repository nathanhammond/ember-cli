'use strict';

const fs = require('fs-extra');
const path = require('path');
const fixturify = require('fixturify');

const originalWorkingDirectory = process.cwd();
const root = path.resolve(__dirname, '..', '..');

const CommandGenerator = require('../../tests/helpers/command-generator');
const ember = new CommandGenerator(path.join(root, 'bin', 'ember'));

const AddonFixture = require('./addon-fixture');

/**
 * The `InRepoAddonFixture` object leverages the similarities between itself and
 * `AddonFixture to minimize its own set of custom helpers. It is used in the
 * same way and for the same reasons as `AppFixture`. Read documentation there.
 *
 * @class InRepoAddonFixture
 * @extends AddonFixture
 */
function InRepoAddonFixture(name) {
  this.type = 'in-repo-addon';
  this.command = null;
  this.name = name;
  this._installedAddonFixtures = [];
  this.serialized = false;

  this._init();
}

InRepoAddonFixture.prototype = Object.create(AddonFixture.prototype);
InRepoAddonFixture.prototype.constructor = InRepoAddonFixture;

/**
 * The `AppFixture` version of this is not designed to use `ember generate`
 * which is necessary for an in-repo-addon.
 *
 * @method _loadBlueprint
 * @override
 */
InRepoAddonFixture.prototype._loadBlueprint = function() {
  fs.emptyDirSync(this.dir);

  // Lie to the generator.
  fs.outputFileSync(path.join(this.dir, 'package.json'), '{}');
  fs.mkdirsSync(path.join(this.dir, 'node_modules'));

  process.chdir(this.dir);
  ember.invoke('generate', 'in-repo-addon', this.name);
  process.chdir(originalWorkingDirectory);

  let self = this;
  let handler = {
    set(target, property, value) {
      self.serialized = false;
      target[property] = value;
      return true;
    },
    deleteProperty(target, property) {
      self.serialized = false;
      delete target[property];
      return true;
    },
  };

  this.fixture = new Proxy(fixturify.readSync(path.join(this.dir, 'lib', this.name)), handler);

  // Clean up after the generator.
  fs.emptyDirSync(this.dir);
};

module.exports = InRepoAddonFixture;
