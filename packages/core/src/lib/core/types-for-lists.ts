import { CacheHint } from 'apollo-server-types';
import {
  BaseItem,
  GraphQLTypesForList,
  getGqlNames,
  NextFieldType,
  BaseListTypeInfo,
  ListGraphQLTypes,
  ListHooks,
  KeystoneConfig,
  FindManyArgs,
  CacheHintArgs,
  MaybePromise,
} from '../../types';
import { graphql } from '../..';
import { FieldHooks } from '../../types/config/hooks';
import { FilterOrderArgs } from '../../types/config/fields';
import {
  ResolvedFieldAccessControl,
  ResolvedListAccessControl,
  parseListAccessControl,
  parseFieldAccessControl,
} from './access-control';
import { getNamesFromList } from './utils';
import { ResolvedDBField, resolveRelationships } from './resolve-relationships';
import { outputTypeField } from './queries/output-field';
import { assertFieldsValid } from './field-assertions';

export type InitialisedField = Omit<NextFieldType, 'dbField' | 'access' | 'graphql'> & {
  dbField: ResolvedDBField;
  access: ResolvedFieldAccessControl;
  hooks: FieldHooks<BaseListTypeInfo>;
  graphql: {
    isEnabled: {
      read: boolean;
      create: boolean;
      update: boolean;
      filter: boolean | ((args: FilterOrderArgs<BaseListTypeInfo>) => MaybePromise<boolean>);
      orderBy: boolean | ((args: FilterOrderArgs<BaseListTypeInfo>) => MaybePromise<boolean>);
    };
    cacheHint: CacheHint | undefined;
  };
};

export type InitialisedList = {
  fields: Record<string, InitialisedField>;
  /** This will include the opposites to one-sided relationships */
  resolvedDbFields: Record<string, ResolvedDBField>;
  pluralGraphQLName: string;
  types: GraphQLTypesForList;
  access: ResolvedListAccessControl;
  hooks: ListHooks<BaseListTypeInfo>;
  adminUILabels: { label: string; singular: string; plural: string; path: string };
  cacheHint: ((args: CacheHintArgs) => CacheHint) | undefined;
  maxResults: number;
  listKey: string;
  lists: Record<string, InitialisedList>;
  dbMap: string | undefined;
  graphql: {
    isEnabled: IsEnabled;
  };
  isSingleton: boolean;
};

type IsEnabled = {
  type: boolean;
  query: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  filter: boolean | ((args: FilterOrderArgs<BaseListTypeInfo>) => MaybePromise<boolean>);
  orderBy: boolean | ((args: FilterOrderArgs<BaseListTypeInfo>) => MaybePromise<boolean>);
};

function throwIfNotAFilter(x: unknown, listKey: string, fieldKey: string) {
  if (['boolean', 'undefined', 'function'].includes(typeof x)) return;

  throw new Error(
    `Configuration option '${listKey}.${fieldKey}' must be either a boolean value or a function. Received '${x}'.`
  );
}

function getIsEnabled(listsConfig: KeystoneConfig['lists']) {
  const isEnabled: Record<string, IsEnabled> = {};

  for (const [listKey, listConfig] of Object.entries(listsConfig)) {
    const omit = listConfig.graphql?.omit;
    const { defaultIsFilterable, defaultIsOrderable } = listConfig;
    if (!omit) {
      // We explicity check for boolean/function values here to ensure the dev hasn't made a mistake
      // when defining these values. We avoid duck-typing here as this is security related
      // and we want to make it hard to write incorrect code.
      throwIfNotAFilter(defaultIsFilterable, listKey, 'defaultIsFilterable');
      throwIfNotAFilter(defaultIsOrderable, listKey, 'defaultIsOrderable');
    }
    if (omit === true) {
      isEnabled[listKey] = {
        type: false,
        query: false,
        create: false,
        update: false,
        delete: false,
        filter: false,
        orderBy: false,
      };
    } else if (omit === undefined) {
      isEnabled[listKey] = {
        type: true,
        query: true,
        create: true,
        update: true,
        delete: true,
        filter: defaultIsFilterable ?? true,
        orderBy: defaultIsOrderable ?? true,
      };
    } else {
      isEnabled[listKey] = {
        type: true,
        query: !omit.includes('query'),
        create: !omit.includes('create'),
        update: !omit.includes('update'),
        delete: !omit.includes('delete'),
        filter: defaultIsFilterable ?? true,
        orderBy: defaultIsOrderable ?? true,
      };
    }
  }

  return isEnabled;
}

type PartiallyInitialisedList = Omit<InitialisedList, 'lists' | 'resolvedDbFields'>;

function getListsWithInitialisedFields(
  { storage: configStorage, lists: listsConfig, db: { provider } }: KeystoneConfig,
  listGraphqlTypes: Record<string, ListGraphQLTypes>,
  intermediateLists: Record<string, { graphql: { isEnabled: IsEnabled } }>
) {
  const result: Record<string, PartiallyInitialisedList> = {};

  for (const [listKey, list] of Object.entries(listsConfig)) {
    const intermediateList = intermediateLists[listKey];
    const resultFields: Record<string, InitialisedField> = {};

    for (const [fieldKey, fieldFunc] of Object.entries(list.fields)) {
      if (typeof fieldFunc !== 'function') {
        throw new Error(`The field at ${listKey}.${fieldKey} does not provide a function`);
      }

      const f = fieldFunc({
        fieldKey,
        listKey,
        lists: listGraphqlTypes,
        provider,
        getStorage: storage => configStorage?.[storage],
      });

      // We explicity check for boolean values here to ensure the dev hasn't made a mistake
      // when defining these values. We avoid duck-typing here as this is security related
      // and we want to make it hard to write incorrect code.
      throwIfNotAFilter(f.isFilterable, listKey, 'isFilterable');
      throwIfNotAFilter(f.isOrderable, listKey, 'isOrderable');

      const omit = f.graphql?.omit;
      const read = omit !== true && !omit?.includes('read');
      const _isEnabled = {
        read,
        update: omit !== true && !omit?.includes('update'),
        create: omit !== true && !omit?.includes('create'),
        // Filter and orderBy can be defaulted at the list level, otherwise they
        // default to `false` if no value was set at the list level.
        filter: read && (f.isFilterable ?? intermediateList.graphql.isEnabled.filter),
        orderBy: read && (f.isOrderable ?? intermediateList.graphql.isEnabled.orderBy),
      };

      resultFields[fieldKey] = {
        ...f,
        dbField: f.dbField as ResolvedDBField,
        access: parseFieldAccessControl(f.access),
        hooks: f.hooks ?? {},
        graphql: {
          cacheHint: f.graphql?.cacheHint,
          isEnabled: _isEnabled,
        },
        input: { ...f.input },
      };
    }

    result[listKey] = {
      fields: resultFields,
      ...intermediateList,
      ...getNamesFromList(listKey, list),
      access: parseListAccessControl(list.access),
      dbMap: list.db?.map,
      types: listGraphqlTypes[listKey].types,

      hooks: list.hooks || {},

      /** These properties aren't related to any of the above actions but need to be here */
      maxResults: list.graphql?.queryLimits?.maxResults ?? Infinity,
      listKey,
      cacheHint: (() => {
        const cacheHint = list.graphql?.cacheHint;
        if (cacheHint === undefined) {
          return undefined;
        }
        return typeof cacheHint === 'function' ? cacheHint : () => cacheHint;
      })(),
      isSingleton: list.isSingleton ?? false,
    };
  }

  return result;
}

function getListGraphqlTypes(
  listsConfig: KeystoneConfig['lists'],
  lists: Record<string, InitialisedList>,
  intermediateLists: Record<string, { graphql: { isEnabled: IsEnabled } }>
): Record<string, ListGraphQLTypes> {
  const graphQLTypes: Record<string, ListGraphQLTypes> = {};

  for (const [listKey, listConfig] of Object.entries(listsConfig)) {
    const names = getGqlNames({
      listKey,
      pluralGraphQLName: getNamesFromList(listKey, listConfig).pluralGraphQLName,
    });

    const output = graphql.object<BaseItem>()({
      name: names.outputTypeName,
      fields: () => {
        const { fields } = lists[listKey];
        return {
          ...Object.fromEntries(
            Object.entries(fields).flatMap(([fieldPath, field]) => {
              if (
                !field.output ||
                !field.graphql.isEnabled.read ||
                (field.dbField.kind === 'relation' &&
                  !intermediateLists[field.dbField.list].graphql.isEnabled.query)
              ) {
                return [];
              }
              return [
                [fieldPath, field.output] as const,
                ...Object.entries(field.extraOutputFields || {}),
              ].map(([outputTypeFieldName, outputField]) => {
                return [
                  outputTypeFieldName,
                  outputTypeField(
                    outputField,
                    field.dbField,
                    field.graphql?.cacheHint,
                    field.access.read,
                    listKey,
                    fieldPath,
                    lists
                  ),
                ];
              });
            })
          ),
        };
      },
    });

    const uniqueWhere = graphql.inputObject({
      name: names.whereUniqueInputName,
      fields: () => {
        const { fields } = lists[listKey];
        return {
          ...Object.fromEntries(
            Object.entries(fields).flatMap(([key, field]) => {
              if (
                !field.input?.uniqueWhere?.arg ||
                !field.graphql.isEnabled.read ||
                !field.graphql.isEnabled.filter
              ) {
                return [];
              }
              return [[key, field.input.uniqueWhere.arg]] as const;
            })
          ),
          // this is exactly what the id field will add
          // but this does it more explicitly so that typescript understands
          id: graphql.arg({ type: graphql.ID }),
        };
      },
    });

    const where: GraphQLTypesForList['where'] = graphql.inputObject({
      name: names.whereInputName,
      fields: () => {
        const { fields } = lists[listKey];
        return Object.assign(
          {
            AND: graphql.arg({ type: graphql.list(graphql.nonNull(where)) }),
            OR: graphql.arg({ type: graphql.list(graphql.nonNull(where)) }),
            NOT: graphql.arg({ type: graphql.list(graphql.nonNull(where)) }),
          },
          ...Object.entries(fields).map(
            ([fieldKey, field]) =>
              field.input?.where?.arg &&
              field.graphql.isEnabled.read &&
              field.graphql.isEnabled.filter && { [fieldKey]: field.input?.where?.arg }
          )
        );
      },
    });

    const create = graphql.inputObject({
      name: names.createInputName,
      fields: () => {
        const { fields } = lists[listKey];
        return Object.fromEntries(
          Object.entries(fields).flatMap(([key, field]) => {
            if (!field.input?.create?.arg || !field.graphql.isEnabled.create) return [];
            return [[key, field.input.create.arg]] as const;
          })
        );
      },
    });

    const update = graphql.inputObject({
      name: names.updateInputName,
      fields: () => {
        const { fields } = lists[listKey];
        return Object.fromEntries(
          Object.entries(fields).flatMap(([key, field]) => {
            if (!field.input?.update?.arg || !field.graphql.isEnabled.update) return [];
            return [[key, field.input.update.arg]] as const;
          })
        );
      },
    });

    const orderBy = graphql.inputObject({
      name: names.listOrderName,
      fields: () => {
        const { fields } = lists[listKey];
        return Object.fromEntries(
          Object.entries(fields).flatMap(([key, field]) => {
            if (
              !field.input?.orderBy?.arg ||
              !field.graphql.isEnabled.read ||
              !field.graphql.isEnabled.orderBy
            ) {
              return [];
            }
            return [[key, field.input.orderBy.arg]] as const;
          })
        );
      },
    });

    const findManyArgs: FindManyArgs = {
      where: graphql.arg({
        type: graphql.nonNull(where),
        defaultValue: listConfig.isSingleton ? ({ id: { equals: '1' } } as {}) : {},
      }),
      orderBy: graphql.arg({
        type: graphql.nonNull(graphql.list(graphql.nonNull(orderBy))),
        defaultValue: [],
      }),
      // TODO: non-nullable when max results is specified in the list with the default of max results
      take: graphql.arg({ type: graphql.Int }),
      skip: graphql.arg({ type: graphql.nonNull(graphql.Int), defaultValue: 0 }),
    };

    const isEnabled = intermediateLists[listKey].graphql.isEnabled;
    let relateToManyForCreate, relateToManyForUpdate, relateToOneForCreate, relateToOneForUpdate;
    if (isEnabled.type) {
      relateToManyForCreate = graphql.inputObject({
        name: names.relateToManyForCreateInputName,
        fields: () => {
          return {
            // Create via a relationship is only supported if this list allows create
            ...(isEnabled.create && {
              create: graphql.arg({ type: graphql.list(graphql.nonNull(create)) }),
            }),
            connect: graphql.arg({ type: graphql.list(graphql.nonNull(uniqueWhere)) }),
          };
        },
      });

      relateToManyForUpdate = graphql.inputObject({
        name: names.relateToManyForUpdateInputName,
        fields: () => {
          return {
            // The order of these fields reflects the order in which they are applied
            // in the mutation.
            disconnect: graphql.arg({ type: graphql.list(graphql.nonNull(uniqueWhere)) }),
            set: graphql.arg({ type: graphql.list(graphql.nonNull(uniqueWhere)) }),
            // Create via a relationship is only supported if this list allows create
            ...(isEnabled.create && {
              create: graphql.arg({ type: graphql.list(graphql.nonNull(create)) }),
            }),
            connect: graphql.arg({ type: graphql.list(graphql.nonNull(uniqueWhere)) }),
          };
        },
      });

      relateToOneForCreate = graphql.inputObject({
        name: names.relateToOneForCreateInputName,
        fields: () => {
          return {
            // Create via a relationship is only supported if this list allows create
            ...(isEnabled.create && { create: graphql.arg({ type: create }) }),
            connect: graphql.arg({ type: uniqueWhere }),
          };
        },
      });

      relateToOneForUpdate = graphql.inputObject({
        name: names.relateToOneForUpdateInputName,
        fields: () => {
          return {
            // Create via a relationship is only supported if this list allows create
            ...(isEnabled.create && { create: graphql.arg({ type: create }) }),
            connect: graphql.arg({ type: uniqueWhere }),
            disconnect: graphql.arg({ type: graphql.Boolean }),
          };
        },
      });
    }

    graphQLTypes[listKey] = {
      types: {
        output,
        uniqueWhere,
        where,
        create,
        orderBy,
        update,
        findManyArgs,
        relateTo: {
          many: {
            where: graphql.inputObject({
              name: `${listKey}ManyRelationFilter`,
              fields: {
                every: graphql.arg({ type: where }),
                some: graphql.arg({ type: where }),
                none: graphql.arg({ type: where }),
              },
            }),
            create: relateToManyForCreate,
            update: relateToManyForUpdate,
          },
          one: { create: relateToOneForCreate, update: relateToOneForUpdate },
        },
      },
    };
  }

  return graphQLTypes;
}

/**
 * 1. Get the `isEnabled` config object from the listConfig - the returned object will be modified later
 * 2. Instantiate `lists` object - it is done here as the object will be added to the listGraphqlTypes
 * 3. Get graphqlTypes
 * 4. Initialise fields - field functions are called
 * 5. Handle relationships - ensure correct linking between two sides of all relationships (including one-sided relationships)
 * 6.
 */
export function initialiseLists(config: KeystoneConfig): Record<string, InitialisedList> {
  const listsConfig = config.lists;

  let intermediateLists;
  intermediateLists = Object.fromEntries(
    Object.entries(getIsEnabled(listsConfig)).map(([key, isEnabled]) => [
      key,
      { graphql: { isEnabled } },
    ])
  );

  /**
   * Lists is instantiated here so that it can be passed into the `getListGraphqlTypes` function
   * This function attaches this list object to the various graphql functions
   *
   * The object will be populated at the end of this function, and the reference will be maintained
   */
  const listsRef: Record<string, InitialisedList> = {};

  {
    const listGraphqlTypes = getListGraphqlTypes(listsConfig, listsRef, intermediateLists);
    intermediateLists = getListsWithInitialisedFields(config, listGraphqlTypes, intermediateLists);
  }

  {
    const resolvedDBFieldsForLists = resolveRelationships(intermediateLists);
    intermediateLists = Object.fromEntries(
      Object.entries(intermediateLists).map(([listKey, blah]) => [
        listKey,
        { ...blah, resolvedDbFields: resolvedDBFieldsForLists[listKey] },
      ])
    );
  }

  intermediateLists = Object.fromEntries(
    Object.entries(intermediateLists).map(([listKey, list]) => {
      const fields: Record<string, InitialisedField> = {};

      for (const [fieldKey, field] of Object.entries(list.fields)) {
        fields[fieldKey] = {
          ...field,
          dbField: list.resolvedDbFields[fieldKey],
        };
      }

      return [listKey, { ...list, fields }];
    })
  );

  for (const list of Object.values(intermediateLists)) {
    let hasAnEnabledCreateField = false;
    let hasAnEnabledUpdateField = false;

    for (const field of Object.values(list.fields)) {
      if (field.input?.create?.arg && field.graphql.isEnabled.create) {
        hasAnEnabledCreateField = true;
      }
      if (field.input?.update && field.graphql.isEnabled.update) {
        hasAnEnabledUpdateField = true;
      }
    }
    // You can't have a graphQL type with no fields, so
    // if they're all disabled, we have to disable the whole operation.
    if (!hasAnEnabledCreateField) {
      list.graphql.isEnabled.create = false;
    }
    if (!hasAnEnabledUpdateField) {
      list.graphql.isEnabled.update = false;
    }
  }

  /*
    Error checking
    */
  for (const [listKey, { fields }] of Object.entries(intermediateLists)) {
    assertFieldsValid({ listKey, fields });
  }

  for (const [listKey, intermediateList] of Object.entries(intermediateLists)) {
    listsRef[listKey] = {
      ...intermediateList,
      lists: listsRef,
    };
  }

  return listsRef;
}
