import type { Model, Sequelize } from '@sequelize/lite';
import { DataTypes, Op, UniqueConstraintError, ValidationError } from '@sequelize/lite';
import { expect } from 'chai';
import { createSequelize, expectRejection } from './support';

interface UserAttributes {
  id: string;
  email: string;
  name: string | null;
  age: number | null;
  role: 'admin' | 'member';
  tags: string[] | null;
  settings: Record<string, unknown> | null;
  birthday: string | null;
  fullName?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

type User = Model<UserAttributes, Partial<UserAttributes>> & UserAttributes;

function defineUser(sequelize: Sequelize, hooks = {}) {
  return sequelize.define<User>(
    'User',
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: { isEmail: true },
      },
      name: { type: DataTypes.STRING(50), validate: { len: [2, 50] } },
      age: { type: DataTypes.INTEGER, validate: { min: 0, max: 150 } },
      role: { type: DataTypes.ENUM('admin', 'member'), allowNull: false, defaultValue: 'member' },
      tags: DataTypes.ARRAY(DataTypes.TEXT),
      settings: DataTypes.JSONB,
      birthday: DataTypes.DATEONLY,
      fullName: {
        type: DataTypes.VIRTUAL,
        get(this: User) {
          return `${this.name ?? ''} <${this.email}>`;
        },
      },
    },
    { underscored: true, hooks },
  );
}

describe('Model', () => {
  let sequelize: Sequelize;

  afterEach(async () => {
    await sequelize?.close();
  });

  describe('CRUD', () => {
    it('creates, reads, updates and destroys rows', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize);
      await sequelize.sync();

      const user = await User.create({
        email: 'ada@example.com',
        name: 'Ada',
        age: 36,
        tags: ['math', 'code'],
        settings: { theme: 'dark', list: [1, 2] },
        birthday: '1815-12-10',
      });

      expect(user.id).to.be.a('string');
      expect(user.role).to.equal('member');
      expect(user.isNewRecord).to.equal(false);
      expect(user.createdAt).to.be.instanceOf(Date);
      expect(user.fullName).to.equal('Ada <ada@example.com>');

      const found = await User.findByPk(user.id);
      expect(found).not.to.equal(null);
      expect(found!.get({ plain: true })).to.deep.include({
        email: 'ada@example.com',
        name: 'Ada',
        age: 36,
        role: 'member',
        tags: ['math', 'code'],
        settings: { theme: 'dark', list: [1, 2] },
        birthday: '1815-12-10',
      });

      // underscored columns
      const { rows } = await sequelize.query('SELECT created_at, updated_at FROM users');
      expect(rows[0].created_at).to.be.instanceOf(Date);

      found!.name = 'Ada Lovelace';
      expect(found!.changed()).to.deep.equal(['name']);
      await found!.save();
      await user.reload();
      expect(user.name).to.equal('Ada Lovelace');
      expect(user.updatedAt!.getTime()).to.be.greaterThanOrEqual(user.createdAt!.getTime());

      await user.update({ age: 37 });
      expect((await User.findByPk(user.id))!.age).to.equal(37);

      await user.destroy();
      expect(await User.findByPk(user.id)).to.equal(null);
      expect(await User.count()).to.equal(0);
    });

    it('supports where operators, order, limit, offset, attributes and raw', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize);
      await sequelize.sync();

      await User.bulkCreate([
        { email: 'a@example.com', name: 'Alice', age: 20, role: 'admin' },
        { email: 'b@example.com', name: 'Bob', age: 30 },
        { email: 'c@example.com', name: 'Carol', age: 40 },
        { email: 'd@example.com', name: null, age: null },
      ]);

      const names = async (where: object, extra = {}) =>
        (await User.findAll({ where, order: [['email', 'ASC']], ...extra })).map(
          user => user.email[0],
        );

      expect(await names({ age: { [Op.gt]: 25 } })).to.deep.equal(['b', 'c']);
      expect(await names({ age: { [Op.gte]: 20, [Op.lt]: 40 } })).to.deep.equal(['a', 'b']);
      expect(await names({ age: [20, 40] })).to.deep.equal(['a', 'c']);
      expect(await names({ age: { [Op.notIn]: [20, 40] } })).to.deep.equal(['b']);
      expect(await names({ age: { [Op.in]: [] } })).to.deep.equal([]);
      expect(await names({ name: null })).to.deep.equal(['d']);
      expect(await names({ name: { [Op.ne]: null } })).to.deep.equal(['a', 'b', 'c']);
      expect(await names({ name: { [Op.startsWith]: 'Ca' } })).to.deep.equal(['c']);
      expect(await names({ name: { [Op.iLike]: '%O%' } })).to.deep.equal(['b', 'c']);
      expect(await names({ age: { [Op.between]: [25, 45] } })).to.deep.equal(['b', 'c']);
      expect(await names({ [Op.or]: [{ role: 'admin' }, { age: 40 }] })).to.deep.equal(['a', 'c']);
      expect(await names({ [Op.or]: { role: 'admin', age: 30 } })).to.deep.equal(['a', 'b']);
      expect(await names({ [Op.not]: { role: 'member' } })).to.deep.equal(['a']);
      expect(await names({}, { limit: 2, offset: 1 })).to.deep.equal(['b', 'c']);

      const oldest = await User.findOne({ order: [['age', 'DESC NULLS LAST']] });
      expect(oldest!.name).to.equal('Carol');

      const raw = await User.findAll({ attributes: ['email'], where: { age: 20 }, raw: true });
      expect(raw).to.deep.equal([{ email: 'a@example.com' }]);

      expect(await User.count({ where: { role: 'member' } })).to.equal(3);
      await expectRejection(User.findAll({ where: { nope: 1 } as any }), /nope/);
    });

    it('supports static update & destroy', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize);
      await sequelize.sync();
      await User.bulkCreate([
        { email: 'a@example.com', age: 20 },
        { email: 'b@example.com', age: 30 },
      ]);

      const [count, rows] = await User.update({ age: 50 }, { where: { age: { [Op.lt]: 25 } } });
      expect(count).to.equal(1);
      expect(rows[0].email).to.equal('a@example.com');

      expect(await User.destroy({ where: { age: 50 } })).to.equal(1);
      expect(await User.count()).to.equal(1);
    });

    it('findOrCreate', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize);
      await sequelize.sync();

      const [first, created] = await User.findOrCreate({
        where: { email: 'x@example.com' },
        defaults: { age: 3 },
      });
      const [second, createdAgain] = await User.findOrCreate({ where: { email: 'x@example.com' } });
      expect(created).to.equal(true);
      expect(createdAgain).to.equal(false);
      expect(second.id).to.equal(first.id);
      expect(second.age).to.equal(3);
    });

    it('uses an autoincrement id when no primary key is defined', async () => {
      sequelize = await createSequelize();
      const Note = sequelize.define('Note', { body: DataTypes.TEXT }, { timestamps: false });
      await sequelize.sync();
      const a = await Note.create({ body: 'a' });
      const b = await Note.create({ body: 'b' });
      expect(a.get('id')).to.equal(1);
      expect(b.get('id')).to.equal(2);
      expect(Note.tableName).to.equal('Notes');
    });

    it('sync({ alter }) adds new columns', async () => {
      sequelize = await createSequelize();
      sequelize.define('Item', { name: DataTypes.STRING }, { timestamps: false });
      await sequelize.sync();

      const pglite = await sequelize.getPGlite();
      const other = await createSequelize({ pglite });
      const Item = other.define(
        'Item',
        { name: DataTypes.STRING, price: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 } },
        { timestamps: false },
      );
      await other.sync({ alter: true });
      const item = await Item.create({ name: 'x', price: '1.50' });
      expect(item.get('price')).to.equal('1.50');
    });
  });

  describe('validation', () => {
    it('rejects invalid values with a ValidationError', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize);
      await sequelize.sync();

      try {
        await User.create({ email: 'not-an-email', name: 'A', age: -1, role: 'boss' as any });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.errors.map(item => [item.path, item.validatorKey])).to.deep.equal([
          ['email', 'isEmail'],
          ['name', 'len'],
          ['age', 'min'],
          ['role', 'ENUM'],
        ]);
      }

      try {
        await User.create({ name: 'Bob' });
        expect.fail('should have thrown');
      } catch (error) {
        expect((error as ValidationError).errors[0]).to.include({
          path: 'email',
          type: 'notNull violation',
          message: 'User.email cannot be null',
        });
      }

      try {
        await User.create({ email: 'a@example.com', age: 'abc' as any });
        expect.fail('should have thrown');
      } catch (error) {
        expect((error as ValidationError).errors[0].message).to.equal(
          "'abc' is not a valid integer",
        );
      }

      expect(await User.count()).to.equal(0);
    });

    it('validates only changed attributes on update and supports custom & model validators', async () => {
      sequelize = await createSequelize();
      const Event = sequelize.define(
        'Event',
        {
          title: {
            type: DataTypes.STRING,
            validate: {
              notEmpty: { msg: 'Title is required' },
              noShouting(value: unknown) {
                if (value === String(value).toUpperCase()) {
                  throw new Error('No shouting');
                }
              },
            },
          },
          startsAt: DataTypes.DATE,
          endsAt: DataTypes.DATE,
        },
        {
          validate: {
            endsAfterStart(this: any) {
              if (this.startsAt && this.endsAt && this.endsAt < this.startsAt) {
                throw new Error('endsAt must be after startsAt');
              }
            },
          },
        },
      );
      await sequelize.sync();

      const errors = async (values: object) => {
        try {
          await Event.create(values);

          return [];
        } catch (error) {
          return (error as ValidationError).errors.map(item => item.message);
        }
      };

      expect(await errors({ title: '' })).to.deep.equal(['Title is required', 'No shouting']);
      expect(await errors({ title: 'LOUD' })).to.deep.equal(['No shouting']);
      expect(
        await errors({
          title: 'Party',
          startsAt: '2026-01-02T00:00:00Z',
          endsAt: '2026-01-01T00:00:00Z',
        }),
      ).to.deep.equal(['endsAt must be after startsAt']);

      const event = await Event.create({ title: 'Party' });
      expect(event.get('startsAt')).to.equal(null);
      await event.update({ startsAt: '2026-01-01T00:00:00Z' });
      expect(event.get('startsAt')).to.be.instanceOf(Date);
    });

    it('skips validation with validate: false', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize);
      await sequelize.sync();
      const user = await User.create({ email: 'nope' }, { validate: false });
      expect(user.email).to.equal('nope');
    });
  });

  describe('hooks', () => {
    it('runs instance hooks in order and lets hooks modify values', async () => {
      sequelize = await createSequelize();
      const calls: string[] = [];
      const record = (name: string) => () => {
        calls.push(name);
      };

      const User = defineUser(sequelize, {
        beforeValidate: [
          (user: User) => {
            calls.push('beforeValidate');
            user.email = user.email?.toLowerCase();
          },
        ],
        afterValidate: record('afterValidate'),
        beforeCreate: record('beforeCreate'),
        beforeSave: (user: User) => {
          calls.push('beforeSave');
          user.name ??= 'Anonymous';
        },
        afterCreate: record('afterCreate'),
        afterSave: record('afterSave'),
      });
      User.beforeUpdate(record('beforeUpdate'));
      User.addHook('afterUpdate', 'named', record('afterUpdate'));
      User.addHook('beforeDestroy', record('beforeDestroy'));
      User.addHook('afterDestroy', record('afterDestroy'));
      await sequelize.sync();

      const user = await User.create({ email: 'ADA@EXAMPLE.COM' });
      expect(user.email).to.equal('ada@example.com');
      expect(user.name).to.equal('Anonymous');
      expect((await User.findByPk(user.id))!.name).to.equal('Anonymous');
      expect(calls.splice(0)).to.deep.equal([
        'beforeValidate',
        'afterValidate',
        'beforeCreate',
        'beforeSave',
        'afterCreate',
        'afterSave',
      ]);

      await user.update({ age: 5 });
      expect(calls.splice(0)).to.deep.equal([
        'beforeValidate',
        'afterValidate',
        'beforeUpdate',
        'beforeSave',
        'afterUpdate',
        'afterSave',
      ]);

      User.removeHook('afterUpdate', 'named');
      await user.update({ age: 6 }, { hooks: false });
      expect(calls.splice(0)).to.deep.equal([]);

      await user.destroy();
      expect(calls.splice(0)).to.deep.equal(['beforeDestroy', 'afterDestroy']);
    });

    it('validates values changed by beforeSave hooks', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize, {
        beforeSave(user: User) {
          user.age = -5;
        },
      });
      await sequelize.sync();
      try {
        await User.create({ email: 'a@example.com' });
        expect.fail('should have thrown');
      } catch (error) {
        expect((error as ValidationError).errors[0].path).to.equal('age');
      }
    });

    it('runs bulk, find & individual hooks', async () => {
      sequelize = await createSequelize();
      const calls: string[] = [];
      const User = defineUser(sequelize);
      for (const name of [
        'beforeBulkCreate',
        'afterBulkCreate',
        'beforeBulkUpdate',
        'afterBulkUpdate',
        'beforeBulkDestroy',
        'afterBulkDestroy',
        'beforeUpdate',
        'beforeDestroy',
        'afterFind',
      ] as const) {
        User.addHook(name, () => {
          calls.push(name);
        });
      }

      User.addHook('beforeFind', (options: any) => {
        calls.push('beforeFind');
        options.where = { ...options.where, role: 'member' };
      });
      await sequelize.sync();

      await User.bulkCreate([
        { email: 'a@example.com', role: 'admin' },
        { email: 'b@example.com' },
      ]);
      expect(calls.splice(0)).to.deep.equal(['beforeBulkCreate', 'afterBulkCreate']);

      expect((await User.findAll()).map(user => user.email)).to.deep.equal(['b@example.com']);
      expect(calls.splice(0)).to.deep.equal(['beforeFind', 'afterFind']);

      await User.update({ age: 1 }, { where: {}, individualHooks: true });
      expect(calls.splice(0)).to.deep.equal([
        'beforeBulkUpdate',
        'beforeUpdate',
        'beforeUpdate',
        'afterBulkUpdate',
      ]);

      await User.destroy({ where: {}, individualHooks: true });
      expect(calls.splice(0)).to.deep.equal([
        'beforeBulkDestroy',
        'beforeDestroy',
        'beforeDestroy',
        'afterBulkDestroy',
      ]);
    });
  });

  describe('transactions', () => {
    it('rolls back data and change log entries together', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize);
      await sequelize.sync();

      await User.create({ email: 'kept@example.com' });
      try {
        await sequelize.transaction(async () => {
          // no transaction option: PGlite has a single connection, the running transaction is used
          await User.create({ email: 'rolled-back@example.com' });
          throw new Error('abort');
        });
      } catch (error) {
        expect((error as Error).message).to.equal('abort');
      }

      expect((await User.findAll()).map(user => user.email)).to.deep.equal(['kept@example.com']);
      expect(await sequelize.countPendingChanges()).to.equal(1);

      // unique violation inside a save does not leave a dangling change log entry
      await expectRejection(User.create({ email: 'kept@example.com' }), UniqueConstraintError);
      expect(await sequelize.countPendingChanges()).to.equal(1);
    });

    it('supports unmanaged transactions and afterCommit', async () => {
      sequelize = await createSequelize();
      const User = defineUser(sequelize);
      await sequelize.sync();

      const committed: string[] = [];
      const transaction = await sequelize.transaction();
      transaction.afterCommit(() => {
        committed.push('done');
      });
      await User.create({ email: 'a@example.com' }, { transaction });
      await transaction.commit();
      expect(committed).to.deep.equal(['done']);

      const rolledBack = await sequelize.transaction();
      await User.create({ email: 'b@example.com' }, { transaction: rolledBack });
      await rolledBack.rollback();

      expect(await User.count()).to.equal(1);
    });
  });
});
