import type { ModelDefinition, NormalizedAttribute } from './model-definition.js';
import { Op } from './operators.js';

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function bindValue(attribute: NormalizedAttribute, value: unknown): unknown {
  if (value == null) {
    return null;
  }

  return attribute.type.toBindParameter(value);
}

/** Collects bind parameters for a query */
export class Parameters {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value === undefined ? null : value);

    return `$${this.values.length}`;
  }
}

export type WhereAttributeValue = unknown;

export type WhereOptions<TAttributes = any> = {
  [K in keyof TAttributes]?: WhereAttributeValue;
} & {
  [Op.and]?: WhereOptions<TAttributes> | Array<WhereOptions<TAttributes>>;
  [Op.or]?: WhereOptions<TAttributes> | Array<WhereOptions<TAttributes>>;
  [Op.not]?: WhereOptions<TAttributes>;
};

export type OrderItem = string | [attribute: string, direction?: string];
export type Order = OrderItem | OrderItem[];

const COMPARISON_OPERATORS = new Map<symbol, string>([
  [Op.eq, '='],
  [Op.ne, '!='],
  [Op.gt, '>'],
  [Op.gte, '>='],
  [Op.lt, '<'],
  [Op.lte, '<='],
  [Op.like, 'LIKE'],
  [Op.notLike, 'NOT LIKE'],
  [Op.iLike, 'ILIKE'],
  [Op.notILike, 'NOT ILIKE'],
  [Op.regexp, '~'],
  [Op.notRegexp, '!~'],
  [Op.iRegexp, '~*'],
  [Op.notIRegexp, '!~*'],
  [Op.overlap, '&&'],
  [Op.contains, '@>'],
  [Op.contained, '<@'],
]);

const LIKE_OPERATORS = new Map<symbol, [operator: string, prefix: string, suffix: string]>([
  [Op.startsWith, ['LIKE', '', '%']],
  [Op.notStartsWith, ['NOT LIKE', '', '%']],
  [Op.endsWith, ['LIKE', '%', '']],
  [Op.notEndsWith, ['NOT LIKE', '%', '']],
  [Op.substring, ['LIKE', '%', '%']],
  [Op.notSubstring, ['NOT LIKE', '%', '%']],
]);

function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, match => `\\${match}`);
}

function isPlainObject(value: unknown): value is Record<string | symbol, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function hasOperators(value: unknown): value is Record<symbol, unknown> {
  return isPlainObject(value) && Object.getOwnPropertySymbols(value).length > 0;
}

function operatorName(operator: symbol): string {
  return operator.description ?? operator.toString();
}

export class WhereBuilder {
  readonly #definition: ModelDefinition;
  readonly #parameters: Parameters;

  constructor(definition: ModelDefinition, parameters: Parameters) {
    this.#definition = definition;
    this.#parameters = parameters;
  }

  build(where: unknown): string {
    if (where == null) {
      return '';
    }

    if (!isPlainObject(where)) {
      throw new TypeError('The "where" option must be a plain object');
    }

    return this.#group(where, 'AND');
  }

  #group(where: Record<string | symbol, unknown>, joiner: 'AND' | 'OR'): string {
    const parts: string[] = [];

    for (const key of Object.keys(where)) {
      const value = where[key];
      if (value === undefined) {
        throw new Error(
          `WHERE parameter "${key}" has invalid "undefined" value on model ${this.#definition.modelName}`,
        );
      }

      parts.push(this.#attribute(this.#definition.getAttribute(key), value));
    }

    for (const operator of Object.getOwnPropertySymbols(where)) {
      const value = where[operator];
      if (operator === Op.and || operator === Op.or) {
        const items = Array.isArray(value) ? value : [value];
        const inner = items
          .map(item => {
            if (!isPlainObject(item)) {
              throw new TypeError(`Invalid value for Op.${operatorName(operator)}`);
            }

            // { [Op.or]: { a: 1, b: 2 } } means a = 1 OR b = 2
            return this.#group(item, !Array.isArray(value) && operator === Op.or ? 'OR' : 'AND');
          })
          .filter(Boolean);

        if (inner.length > 0) {
          parts.push(`(${inner.join(operator === Op.and ? ' AND ' : ' OR ')})`);
        }
      } else if (operator === Op.not) {
        if (!isPlainObject(value)) {
          throw new TypeError('Op.not at the top level must be used with an object');
        }

        const inner = this.#group(value, 'AND');
        if (inner) {
          parts.push(`NOT (${inner})`);
        }
      } else {
        throw new Error(`Op.${operatorName(operator)} cannot be used at the top level of a where`);
      }
    }

    if (parts.length === 0) {
      return '';
    }

    return parts.length === 1 ? parts[0] : `(${parts.join(` ${joiner} `)})`;
  }

  #attribute(attribute: NormalizedAttribute, value: unknown): string {
    const column = quoteIdentifier(attribute.field);

    if (hasOperators(value)) {
      const parts = Object.getOwnPropertySymbols(value).map(operator => {
        if (operator === Op.and || operator === Op.or) {
          const items = value[operator];
          if (!Array.isArray(items)) {
            throw new TypeError(
              `Op.${operatorName(operator)} on an attribute must be used with an array`,
            );
          }

          return `(${items
            .map(item => this.#attribute(attribute, item))
            .join(operator === Op.and ? ' AND ' : ' OR ')})`;
        }

        return this.#operator(attribute, column, operator, value[operator]);
      });

      return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
    }

    if (Array.isArray(value) && attribute.type.key !== 'ARRAY') {
      return this.#operator(attribute, column, Op.in, value);
    }

    return this.#operator(attribute, column, Op.eq, value);
  }

  #operator(
    attribute: NormalizedAttribute,
    column: string,
    operator: symbol,
    value: unknown,
  ): string {
    const parameters = this.#parameters;

    if (value === undefined) {
      throw new Error(`Op.${operatorName(operator)} on "${attribute.name}" received undefined`);
    }

    switch (operator) {
      case Op.eq:
      case Op.is:
        if (value === null || typeof value === 'boolean') {
          return `${column} IS ${value === null ? 'NULL' : String(value).toUpperCase()}`;
        }

        if (operator === Op.is) {
          throw new TypeError('Op.is only accepts null, true or false');
        }

        return `${column} = ${parameters.add(bindValue(attribute, value))}`;
      case Op.ne:
      case Op.not:
      case Op.isNot:
        if (value === null || typeof value === 'boolean') {
          return `${column} IS NOT ${value === null ? 'NULL' : String(value).toUpperCase()}`;
        }

        if (operator === Op.isNot) {
          throw new TypeError('Op.isNot only accepts null, true or false');
        }

        return `${column} != ${parameters.add(bindValue(attribute, value))}`;
      case Op.in:
      case Op.notIn: {
        if (!Array.isArray(value)) {
          throw new TypeError(`Op.${operatorName(operator)} expects an array`);
        }

        if (value.length === 0) {
          return operator === Op.in ? 'FALSE' : 'TRUE';
        }

        const list = value.map(item => parameters.add(bindValue(attribute, item))).join(', ');

        return `${column} ${operator === Op.in ? 'IN' : 'NOT IN'} (${list})`;
      }

      case Op.between:
      case Op.notBetween: {
        if (!Array.isArray(value) || value.length !== 2) {
          throw new TypeError(`Op.${operatorName(operator)} expects an array of two values`);
        }

        return `${column} ${operator === Op.between ? 'BETWEEN' : 'NOT BETWEEN'} ${parameters.add(
          bindValue(attribute, value[0]),
        )} AND ${parameters.add(bindValue(attribute, value[1]))}`;
      }

      default:
    }

    const like = LIKE_OPERATORS.get(operator);
    if (like) {
      const [sqlOperator, prefix, suffix] = like;

      return `${column} ${sqlOperator} ${parameters.add(`${prefix}${escapeLike(String(value))}${suffix}`)}`;
    }

    const sqlOperator = COMPARISON_OPERATORS.get(operator);
    if (!sqlOperator) {
      throw new Error(`Operator Op.${operatorName(operator)} is not supported by @sequelize/lite`);
    }

    // LIKE & regexp operators take strings, not values of the attribute's type
    const bound =
      sqlOperator.includes('LIKE') || sqlOperator.includes('~')
        ? String(value)
        : bindValue(attribute, value);

    return `${column} ${sqlOperator} ${parameters.add(bound)}`;
  }
}

const DIRECTION = /^(?:ASC|DESC)(?: NULLS (?:FIRST|LAST))?$/i;

export function buildOrder(definition: ModelDefinition, order: Order | undefined): string {
  if (order === undefined) {
    return '';
  }

  const isSingleItem =
    typeof order === 'string' ||
    (order.length === 2 &&
      typeof order[0] === 'string' &&
      typeof order[1] === 'string' &&
      DIRECTION.test(order[1]));
  const items = (isSingleItem ? [order] : order) as OrderItem[];

  return items
    .map(item => {
      const [attributeName, direction = 'ASC'] = typeof item === 'string' ? [item] : item;
      if (!DIRECTION.test(direction)) {
        throw new Error(`Invalid order direction "${direction}"`);
      }

      return `${quoteIdentifier(definition.getAttribute(attributeName).field)} ${direction.toUpperCase()}`;
    })
    .join(', ');
}
