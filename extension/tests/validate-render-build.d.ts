declare module '../scripts/validate-render-build.mjs' {
  export declare function hasExactRootBuildCommand(command: string): boolean;

  export interface RenderBuildConfiguration {
    readonly prefixes: string[];
    readonly command: string;
  }

  export declare function validateRenderBuildConfiguration(input: {
    readonly rootPackage: { readonly scripts: Record<string, string> };
    readonly renderYaml: string;
  }): Promise<RenderBuildConfiguration>;
}
