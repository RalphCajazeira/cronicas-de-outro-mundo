import { describe, expect, it } from 'vitest';
import { validateRenderBuildConfiguration } from '../scripts/validate-render-build.mjs';

const baseScripts = {
  build: 'npm ci --prefix backend --include=dev && npm run build:widget && npm ci --prefix oauth-ui --include=dev && npm run build:oauth-ui && npm run build:extension',
  'build:widget': 'npm ci --prefix widget --include=dev && npm run build',
  'build:oauth-ui': 'npm ci --prefix oauth-ui --include=dev && npm run build',
  'build:extension': 'npm ci --prefix extension --include=dev && npm run build',
};

describe('render build validation', () => {
  it('accepts a build chain with npm run build as an independent step', async () => {
    const result = await validateRenderBuildConfiguration({
      rootPackage: { scripts: baseScripts },
      renderYaml: 'buildCommand:   npm ci --prefix backend --include=dev && npm ci --prefix widget --include=dev && npm ci --prefix oauth-ui --include=dev && npm ci --prefix extension --include=dev &&   npm run build  ',
    });
    expect(result.prefixes.sort()).toEqual(['backend', 'extension', 'oauth-ui', 'widget']);
  });

  it('rejects a render command that does not invoke npm run build', async () => {
    await expect(() => validateRenderBuildConfiguration({
      rootPackage: { scripts: baseScripts },
      renderYaml: 'buildCommand: npm ci --prefix backend --include=dev && npm ci --prefix widget --include=dev && npm ci --prefix oauth-ui --include=dev && npm ci --prefix extension --include=dev && npm run build:widget',
    })).rejects.toThrow('must invoke npm run build');
  });

  it('rejects npm run build:chatgpt-app as equivalent command', async () => {
    await expect(() => validateRenderBuildConfiguration({
      rootPackage: { scripts: { ...baseScripts, 'build:chatgpt-app': 'npm run build --prefix backend' } },
      renderYaml: 'buildCommand: npm ci --prefix backend --include=dev && npm ci --prefix widget --include=dev && npm ci --prefix oauth-ui --include=dev && npm ci --prefix extension --include=dev && npm run build:chatgpt-app',
    })).rejects.toThrow('must invoke npm run build as an independent command segment');
  });

  it('rejects npm run build:extension as equivalent command', async () => {
    await expect(() => validateRenderBuildConfiguration({
      rootPackage: { scripts: baseScripts },
      renderYaml: 'buildCommand: npm ci --prefix backend --include=dev && npm ci --prefix widget --include=dev && npm ci --prefix oauth-ui --include=dev && npm ci --prefix extension --include=dev && npm run build:extension',
    })).rejects.toThrow('must invoke npm run build as an independent command segment');
  });

  it('rejects missing npm ci --prefix install for a required workspace', async () => {
    await expect(() => validateRenderBuildConfiguration({
      rootPackage: { scripts: baseScripts },
      renderYaml: 'buildCommand: npm ci --prefix backend --include=dev && npm ci --prefix widget --include=dev && npm ci --prefix oauth-ui --include=dev && npm run build',
    })).rejects.toThrow('must install extension with npm ci --include=dev.');
  });

  it('rejects unknown workspace install when referenced by build', async () => {
    await expect(() => validateRenderBuildConfiguration({
      rootPackage: {
        scripts: {
          ...baseScripts,
          build: 'npm run build:widget && npm run build:widget-extra',
          'build:widget-extra': 'npm run build --prefix extension-extra',
        },
      },
      renderYaml: 'buildCommand: npm ci --prefix backend --include=dev && npm ci --prefix widget --include=dev && npm ci --prefix oauth-ui --include=dev && npm ci --prefix extension --include=dev && npm run build',
    })).rejects.toThrow('must install extension-extra');
  });
});
