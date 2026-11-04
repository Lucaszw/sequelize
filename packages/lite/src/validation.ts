import contains from 'validator/lib/contains';
import equals from 'validator/lib/equals';
import isAlpha from 'validator/lib/isAlpha';
import isAlphanumeric from 'validator/lib/isAlphanumeric';
import isDecimal from 'validator/lib/isDecimal';
import isEmail from 'validator/lib/isEmail';
import isFloat from 'validator/lib/isFloat';
import isHexColor from 'validator/lib/isHexColor';
import isIP from 'validator/lib/isIP';
import isInt from 'validator/lib/isInt';
import isLowercase from 'validator/lib/isLowercase';
import isNumeric from 'validator/lib/isNumeric';
import isURL from 'validator/lib/isURL';
import isUUID from 'validator/lib/isUUID';
import isUppercase from 'validator/lib/isUppercase';
import { ValidationErrorItem } from './errors.js';
import type { NormalizedAttribute } from './model-definition.js';

type BuiltinValidator = (value: unknown, args: unknown[]) => boolean;

function toRegExp(args: unknown[]): RegExp {
  const [pattern, flags] = args;
  if (pattern instanceof RegExp) {
    return pattern;
  }

  return new RegExp(String(pattern), typeof flags === 'string' ? flags : undefined);
}

const str = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

function length(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  return [...str(value)].length;
}

/**
 * Built-in validators, a subset of the ones supported by @sequelize/core (using the same names & argument shapes).
 */
export const VALIDATORS: Record<string, BuiltinValidator> = {
  is: (value, args) => toRegExp(args).test(str(value)),
  matches: (value, args) => toRegExp(args).test(str(value)),
  not: (value, args) => !toRegExp(args).test(str(value)),
  notRegex: (value, args) => !toRegExp(args).test(str(value)),
  isEmail: (value, [options]) => isEmail(str(value), options as any),
  isUrl: (value, [options]) => isURL(str(value), options as any),
  isIP: (value, [version]) => isIP(str(value), version as any),
  isIPv4: value => isIP(str(value), 4),
  isIPv6: value => isIP(str(value), 6),
  isAlpha: (value, [locale]) => isAlpha(str(value), locale as any),
  isAlphanumeric: (value, [locale]) => isAlphanumeric(str(value), locale as any),
  isNumeric: value => isNumeric(str(value)),
  isInt: (value, [options]) => isInt(str(value), options as any),
  isFloat: (value, [options]) => isFloat(str(value), options as any),
  isDecimal: value => isDecimal(str(value)),
  isHexColor: value => isHexColor(str(value)),
  isLowercase: value => isLowercase(str(value)),
  isUppercase: value => isUppercase(str(value)),
  isUUID: (value, [version]) => isUUID(str(value), (version ?? 'all') as any),
  isDate: value => !Number.isNaN(new Date(value as any).getTime()),
  isAfter: (value, [date]) => new Date(value as any) > new Date((date as any) ?? Date.now()),
  isBefore: (value, [date]) => new Date(value as any) < new Date((date as any) ?? Date.now()),
  isArray: value => Array.isArray(value),
  contains: (value, [seed]) => contains(str(value), String(seed)),
  notContains: (value, [seed]) => !contains(str(value), String(seed)),
  equals: (value, [comparison]) => equals(str(value), String(comparison)),
  notEmpty: value => (Array.isArray(value) ? value.length > 0 : str(value).trim() !== ''),
  len(value, args) {
    const [min = 0, max] = (Array.isArray(args[0]) ? args[0] : args) as [number?, number?];
    const actual = length(value);

    return actual >= min && (max === undefined || actual <= max);
  },
  isIn: (value, [values]) => (values as unknown[]).map(String).includes(str(value)),
  notIn: (value, [values]) => !(values as unknown[]).map(String).includes(str(value)),
  min: (value, [min]) => Number(value) >= Number(min),
  max: (value, [max]) => Number(value) <= Number(max),
};

type AttributeValidatorOption =
  | boolean
  | string
  | number
  | RegExp
  | readonly unknown[]
  | Record<string, unknown>
  | { msg?: string; args?: unknown };

export type CustomValidator = (this: any, value: unknown) => unknown;

export type AttributeValidateOptions = {
  [K in keyof typeof VALIDATORS]?: AttributeValidatorOption;
} & Record<string, AttributeValidatorOption | CustomValidator>;

export type ModelValidateOptions = Record<string, (this: any) => unknown>;

function normalizeBuiltinArgs(
  name: string,
  option: unknown,
): { args: unknown[]; msg: string | undefined } {
  let args: unknown = option;
  let msg: string | undefined;

  if (
    typeof option === 'object' &&
    option !== null &&
    !Array.isArray(option) &&
    !(option instanceof RegExp) &&
    ('msg' in option || 'args' in option)
  ) {
    msg = (option as { msg?: string }).msg;
    args = (option as { args?: unknown }).args ?? true;
  }

  if (args === true) {
    return { args: [], msg };
  }

  if (name === 'isIn' || name === 'notIn') {
    // isIn: [['a', 'b']]
    return { args: Array.isArray(args) && Array.isArray(args[0]) ? args : [args], msg };
  }

  if (
    (name === 'is' ||
      name === 'not' ||
      name === 'matches' ||
      name === 'notRegex' ||
      name === 'len') &&
    Array.isArray(args)
  ) {
    return { args, msg };
  }

  return { args: [args], msg };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ValidateAttributesParams {
  modelName: string;
  instance: object;
  attributes: Iterable<NormalizedAttribute>;
  values: Record<string, unknown>;
  /** attributes that may be null even if `allowNull` is false, because they will be set later */
  nullableAttributes: ReadonlySet<string>;
  modelValidators: ModelValidateOptions | undefined;
}

export async function validateAttributes(
  params: ValidateAttributesParams,
): Promise<ValidationErrorItem[]> {
  const { instance, modelName } = params;
  const errors: ValidationErrorItem[] = [];

  for (const attribute of params.attributes) {
    const value = params.values[attribute.name];

    if (value == null) {
      if (!attribute.allowNull && !params.nullableAttributes.has(attribute.name)) {
        errors.push(
          new ValidationErrorItem(
            `${modelName}.${attribute.name} cannot be null`,
            'notNull violation',
            attribute.name,
            value ?? null,
            instance,
            'is_null',
          ),
        );
      }

      continue;
    }

    const typeError = attribute.type.validate(value);
    if (typeError) {
      errors.push(
        new ValidationErrorItem(
          typeError,
          'Validation error',
          attribute.name,
          value,
          instance,
          attribute.type.key,
        ),
      );
      continue;
    }

    for (const [validatorName, option] of Object.entries(attribute.validate ?? {})) {
      if (typeof option === 'function') {
        try {
          // eslint-disable-next-line no-await-in-loop -- validators run sequentially
          await option.call(instance, value);
        } catch (error) {
          errors.push(
            new ValidationErrorItem(
              errorMessage(error),
              'Validation error',
              attribute.name,
              value,
              instance,
              validatorName,
            ),
          );
        }

        continue;
      }

      if (option === false) {
        continue;
      }

      const validator = VALIDATORS[validatorName];
      if (!validator) {
        throw new Error(
          `Invalid validator "${validatorName}" on attribute ${modelName}.${attribute.name}`,
        );
      }

      const { args, msg } = normalizeBuiltinArgs(validatorName, option);
      if (!validator(value, args)) {
        errors.push(
          new ValidationErrorItem(
            msg ?? `Validation ${validatorName} on ${attribute.name} failed`,
            'Validation error',
            attribute.name,
            value,
            instance,
            validatorName,
            args,
          ),
        );
      }
    }
  }

  for (const [validatorName, validator] of Object.entries(params.modelValidators ?? {})) {
    try {
      // eslint-disable-next-line no-await-in-loop -- validators run sequentially
      await validator.call(instance);
    } catch (error) {
      errors.push(
        new ValidationErrorItem(
          errorMessage(error),
          'custom validation error',
          validatorName,
          null,
          instance,
          validatorName,
        ),
      );
    }
  }

  return errors;
}
