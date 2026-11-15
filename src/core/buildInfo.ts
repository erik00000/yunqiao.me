/** Build metadata is public and contains no machine paths, environment values or credentials. */
export interface BuildInfo { id: string; builtAt: string; revision: string; channel: 'local' | 'release' }
declare const __YUNQIAO_BUILD_INFO__: BuildInfo;
export const buildInfo: BuildInfo | undefined = typeof __YUNQIAO_BUILD_INFO__ === 'undefined' ? undefined : __YUNQIAO_BUILD_INFO__;
