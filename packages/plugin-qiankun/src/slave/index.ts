import address from 'address';
import assert from 'assert';
import { isString, isEqual } from 'lodash';
import { join } from 'path';
import { IApi, utils } from 'umi';
import {
  addSpecifyPrefixedRoute,
  defaultSlaveRootId,
  qiankunStateFromMasterModelNamespace,
} from '../common';
import { SlaveOptions } from '../types';

const localIpAddress = process.env.USE_REMOTE_IP ? address.ip() : 'localhost';

export default function(api: IApi) {
  api.describe({
    enableBy() {
      return (
        !!api.userConfig?.qiankun?.slave ||
        isEqual(api.userConfig?.qiankun, {}) ||
        !!process.env.INITIAL_QIANKUN_SLAVE_OPTIONS
      );
    },
  });

  const options: SlaveOptions = api.userConfig?.qiankun?.slave!;
  const { shouldNotModifyRuntimePublicPath = false } = options || {};

  api.addRuntimePlugin(() => require.resolve('./runtimePlugin'));

  api.register({
    key: 'addExtraModels',
    fn: () => [
      {
        absPath: utils.winPath(join(__dirname, '../qiankunModel.ts')),
        namespace: qiankunStateFromMasterModelNamespace,
      },
    ],
  });

  // eslint-disable-next-line import/no-dynamic-require, global-require
  api.modifyDefaultConfig(memo => {
    const { shouldNotModifyDefaultBase }: SlaveOptions = {
      ...JSON.parse(process.env.INITIAL_QIANKUN_SLAVE_OPTIONS || '{}'),
      ...api.config?.qiankun?.slave,
    };

    const modifiedConfig = {
      ...memo,
      disableGlobalVariables: true,
      mountElementId: defaultSlaveRootId,
      // 默认开启 runtimePublicPath，避免出现 dynamic import 场景子应用资源地址出问题
      runtimePublicPath: true,
      runtimeHistory: {},
    };

    if (!shouldNotModifyDefaultBase) {
      modifiedConfig.base = `/${api.pkg.name}`;
    }

    return modifiedConfig;
  });

  api.modifyConfig(config => ({
    ...config,
    qiankun: {
      ...config?.qiankun,
      slave: {
        ...JSON.parse(process.env.INITIAL_QIANKUN_SLAVE_OPTIONS || '{}'),
        ...config?.qiankun?.slave,
      },
    },
  }));

  if (
    api.userConfig.runtimePublicPath !== false &&
    !shouldNotModifyRuntimePublicPath
  ) {
    api.modifyPublicPathStr(
      () =>
        `window.__INJECTED_PUBLIC_PATH_BY_QIANKUN__ || "${
          // 开发阶段 publicPath 配置无效，默认为 /
          process.env.NODE_ENV !== 'development'
            ? api.config.publicPath || '/'
            : '/'
        }"`,
    );
  }

  const port = process.env.PORT;
  const protocol = process.env.HTTPS ? 'https' : 'http';

  api.chainWebpack(config => {
    assert(api.pkg.name, 'You should have name in package.json');
    config.output
      .libraryTarget('umd')
      .library(`${api.pkg.name}-[name]`)
      .jsonpFunction(`webpackJsonp_${api.pkg.name}`);
    return config;
  });

  // umi bundle 添加 entry 标记
  api.modifyHTML($ => {
    $('script').each((_, el) => {
      const scriptEl = $(el);
      const umiEntryJs = /\/?umi(\.\w+)?\.js$/g;
      if (umiEntryJs.test(scriptEl.attr('src') ?? '')) {
        scriptEl.attr('entry', '');
      }
    });

    return $;
  });

  // source-map 跨域设置
  if (process.env.NODE_ENV === 'development' && port) {
    // 变更 webpack-dev-server websocket 默认监听地址
    process.env.SOCKET_SERVER = `${protocol}://${localIpAddress}:${port}/`;
    api.chainWebpack((memo, { webpack }) => {
      // 禁用 devtool，启用 SourceMapDevToolPlugin
      memo.devtool(false);
      memo.plugin('source-map').use(webpack.SourceMapDevToolPlugin, [
        {
          // @ts-ignore
          namespace: api.pkg.name,
          append: `\n//# sourceMappingURL=${protocol}://${localIpAddress}:${port}/[url]`,
          filename: '[file].map',
        },
      ]);
      return memo;
    });
  }

  const lifecyclePath = require.resolve('./lifecycles');
  api.addEntryImports(() => {
    return {
      source: lifecyclePath,
      specifier:
        '{ genMount as qiankun_genMount, genBootstrap as qiankun_genBootstrap, genUnmount as qiankun_genUnmount, genUpdate as qiankun_genUpdate }',
    };
  });
  api.addEntryCode(
    () =>
      `
    export const bootstrap = qiankun_genBootstrap(clientRender);
    export const mount = qiankun_genMount();
    export const unmount = qiankun_genUnmount('${api.config.mountElementId}');
    export const update = qiankun_genUpdate();

    if (!window.__POWERED_BY_QIANKUN__) {
      bootstrap().then(mount);
    }
    `,
  );

  useLegacyMode(api);
}

function useLegacyMode(api: IApi) {
  const options: SlaveOptions = api.userConfig?.qiankun?.slave!;
  const { keepOriginalRoutes = false } = options || {};

  api.onGenerateFiles(() => {
    api.writeTmpFile({
      path: 'plugin-qiankun/qiankunContext.js',
      content: `
      import { createContext, useContext } from 'react';

      export const Context = createContext(null);
      export function useRootExports() {
        if (process.env.NODE_ENV === 'development') {
          console.warn(
            '[@umijs/plugin-qiankun] Deprecated: useRootExports 通信方式不再推荐，建议您升级到新的应用通信模式，以获得更好的开发体验。详见 https://umijs.org/plugins/plugin-qiankun#%E7%88%B6%E5%AD%90%E5%BA%94%E7%94%A8%E9%80%9A%E8%AE%AF',
          );
        }
        return useContext(Context);
      }`.trim(),
    });
  });

  api.addUmiExports(() => [
    {
      specifiers: ['useRootExports'],
      source: '../plugin-qiankun/qiankunContext',
    },
  ]);

  api.modifyRoutes(routes => {
    // 开启keepOriginalRoutes配置
    if (keepOriginalRoutes === true || isString(keepOriginalRoutes)) {
      return addSpecifyPrefixedRoute(routes, keepOriginalRoutes, api.pkg.name);
    }

    return routes;
  });
}
