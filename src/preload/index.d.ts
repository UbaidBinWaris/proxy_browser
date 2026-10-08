import type { ProxyQaApi } from '../shared/ipc'
declare global {
  interface Window {
    api: ProxyQaApi
  }
}
export {}
