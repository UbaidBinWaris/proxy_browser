/**
 * The shared contract (`src/shared/types.ts`) types `AppInfo.platform` as `NodeJS.Platform | string`.
 * The renderer tsconfig deliberately excludes Node typings, so this ambient declaration provides
 * just that one alias (mirroring @types/node) without exposing Node globals to renderer code.
 */
declare namespace NodeJS {
  type Platform =
    | 'aix'
    | 'android'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'openbsd'
    | 'sunos'
    | 'win32'
    | 'cygwin'
    | 'netbsd'
}
