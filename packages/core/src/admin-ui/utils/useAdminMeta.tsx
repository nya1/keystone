import { useEffect, useMemo, useState } from 'react';
import hashString from '@emotion/hash';
import { AdminMeta, FieldViews, getGqlNames } from '../../types';
import { useLazyQuery } from '../apollo';
import { StaticAdminMetaQuery, staticAdminMetaQuery } from '../admin-meta-graphql';

const expectedExports = new Set(['Cell', 'Field', 'controller', 'CardValue']);

const adminMetaLocalStorageKey = 'keystone.adminMeta';

let _mustRenderServerResult = true;

function useMustRenderServerResult() {
  let [, forceUpdate] = useState(0);
  useEffect(() => {
    _mustRenderServerResult = false;
    forceUpdate(1);
  }, []);

  if (typeof window === 'undefined') {
    return true;
  }

  return _mustRenderServerResult;
}

export function useAdminMeta(adminMetaHash: string, fieldViews: FieldViews) {
  const adminMetaFromLocalStorage = useMemo(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const item = localStorage.getItem(adminMetaLocalStorageKey);
    if (item === null) {
      return;
    }
    try {
      let parsed = JSON.parse(item);
      if (parsed.hash === adminMetaHash) {
        return parsed.meta as StaticAdminMetaQuery['keystone']['adminMeta'];
      }
    } catch (err) {
      return;
    }
  }, [adminMetaHash]);

  // it seems like Apollo doesn't skip the first fetch when using skip: true so we're using useLazyQuery instead
  const [fetchStaticAdminMeta, { data, error, called }] = useLazyQuery(staticAdminMetaQuery, {
    fetchPolicy: 'network-only',
  });

  let shouldFetchAdminMeta = adminMetaFromLocalStorage === undefined && !called;

  useEffect(() => {
    if (shouldFetchAdminMeta) {
      fetchStaticAdminMeta();
    }
  }, [shouldFetchAdminMeta, fetchStaticAdminMeta]);

  const runtimeAdminMeta = useMemo(() => {
    if ((!data || error) && !adminMetaFromLocalStorage) {
      return undefined;
    }
    const adminMeta: StaticAdminMetaQuery['keystone']['adminMeta'] = adminMetaFromLocalStorage
      ? adminMetaFromLocalStorage
      : data.keystone.adminMeta;
    const runtimeAdminMeta: AdminMeta = {
      lists: {},
    };
    adminMeta.lists.forEach(list => {
      runtimeAdminMeta.lists[list.key] = {
        ...list,
        gqlNames: getGqlNames({ listKey: list.key, pluralGraphQLName: list.listQueryName }),
        fields: {},
      };
      list.fields.forEach(field => {
        expectedExports.forEach(exportName => {
          if ((fieldViews[field.viewsIndex] as any)[exportName] === undefined) {
            throw new Error(
              `The view for the field at ${list.key}.${field.path} is missing the ${exportName} export`
            );
          }
        });
        Object.keys(fieldViews[field.viewsIndex]).forEach(exportName => {
          if (!expectedExports.has(exportName) && exportName !== 'allowedExportsOnCustomViews') {
            throw new Error(
              `Unexpected export named ${exportName} from the view from the field at ${list.key}.${field.path}`
            );
          }
        });
        const views = { ...fieldViews[field.viewsIndex] };
        const customViews: Record<string, any> = {};
        if (field.customViewsIndex !== null) {
          const customViewsSource: FieldViews[number] & Record<string, any> =
            fieldViews[field.customViewsIndex];
          const allowedExportsOnCustomViews = new Set(views.allowedExportsOnCustomViews);
          Object.keys(customViewsSource).forEach(exportName => {
            if (allowedExportsOnCustomViews.has(exportName)) {
              customViews[exportName] = customViewsSource[exportName];
            } else if (expectedExports.has(exportName)) {
              (views as any)[exportName] = customViewsSource[exportName];
            } else {
              throw new Error(
                `Unexpected export named ${exportName} from the custom view from field at ${list.key}.${field.path}`
              );
            }
          });
        }
        runtimeAdminMeta.lists[list.key].fields[field.path] = {
          ...field,
          itemView: {
            fieldMode: field.itemView?.fieldMode ?? null,
          },
          views,
          controller: fieldViews[field.viewsIndex].controller({
            listKey: list.key,
            fieldMeta: field.fieldMeta,
            label: field.label,
            description: field.description,
            path: field.path,
            customViews,
          }),
        };
      });
    });
    if (typeof window !== 'undefined' && !adminMetaFromLocalStorage) {
      localStorage.setItem(
        adminMetaLocalStorageKey,
        JSON.stringify({ hash: hashString(JSON.stringify(adminMeta)), meta: adminMeta })
      );
    }
    return runtimeAdminMeta;
  }, [data, error, adminMetaFromLocalStorage, fieldViews]);

  const mustRenderServerResult = useMustRenderServerResult();

  if (mustRenderServerResult) {
    return { state: 'loading' as const };
  }
  if (runtimeAdminMeta) {
    return { state: 'loaded' as const, value: runtimeAdminMeta };
  }
  if (error) {
    return {
      state: 'error' as const,
      error,
      refetch: () => {
        fetchStaticAdminMeta();
      },
    };
  }
  return { state: 'loading' as const };
}
