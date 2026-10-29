import { create } from 'zustand'

/** The browser was stopped because its exit IP changed (BrowserSession.error.code === 'IP_CHANGED'). */
export interface IpStopAlert {
  runId: string
  profileName: string
  message: string
}

interface IpStopAlertState {
  alert: IpStopAlert | null
  show: (alert: IpStopAlert) => void
  dismiss: () => void
}

export const useIpStopAlertStore = create<IpStopAlertState>((set) => ({
  alert: null,
  show: (alert) => set({ alert }),
  dismiss: () => set({ alert: null }),
}))
