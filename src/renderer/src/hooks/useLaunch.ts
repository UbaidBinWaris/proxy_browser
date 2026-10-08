import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Profile } from '@shared/types'
import { getApi, unwrap } from '../lib/api'
import { historyRunPath } from '../lib/navigation'
import { useSessionsStore } from '../stores/sessions'
import { toast } from '../stores/toasts'

/** The minimum a caller needs to launch: a profile id (and its name for error toasts). */
export type LaunchTarget = Pick<Profile, 'id' | 'name'>

export interface LaunchController {
  /** Profile id whose launch request is in flight, if any. */
  launchingId: string | null
  /** Start a browser for the profile and go to its run page. Resolves once the request has been accepted. */
  launch: (target: LaunchTarget) => Promise<void>
}

/**
 * Launch flow for the NON-BLOCKING `browser.launch`: the main process answers immediately with the
 * BrowserSession in status 'starting' (its TestRun row already exists), then streams progress through
 * `event:session-update` / `event:run-update`. We seed the sessions store (unless an event already got
 * there first) and navigate straight to /history/<runId>, where LaunchPanel renders the live steps.
 *
 * Validation and missing-browser failures are still returned as IpcResult failures and shown as a toast.
 */
export function useLaunch(): LaunchController {
  const navigate = useNavigate()
  const upsert = useSessionsStore((s) => s.upsert)
  const [launchingId, setLaunchingId] = useState<string | null>(null)

  const launch = useCallback(
    async (target: LaunchTarget): Promise<void> => {
      setLaunchingId(target.id)
      try {
        const session = await unwrap(getApi().browser.launch(target.id))
        // Progress events may already have advanced this session; never regress it to the 'starting' snapshot.
        if (!useSessionsStore.getState().sessions[session.id]) upsert(session)
        navigate(historyRunPath(session.runId))
      } catch (err) {
        toast.fromError(err, `Could not launch "${target.name}"`)
      } finally {
        setLaunchingId(null)
      }
    },
    [navigate, upsert],
  )

  return { launchingId, launch }
}
