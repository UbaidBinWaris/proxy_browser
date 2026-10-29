import { Link, useNavigate } from 'react-router-dom'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { historyRunPath } from '@/lib/navigation'
import { useIpStopAlertStore } from '@/stores/ipStopAlert'

/**
 * Modal shown when a browser was stopped because its exit IP changed. The browser is already
 * closed and its traffic was blocked first, so the form could not be sent from the new IP;
 * the user only has to launch again.
 */
export function IpStopDialog(): React.JSX.Element | null {
  const alert = useIpStopAlertStore((s) => s.alert)
  const dismiss = useIpStopAlertStore((s) => s.dismiss)
  const navigate = useNavigate()
  if (!alert) return null
  return (
    <ConfirmDialog
      open
      title="Browser stopped: the IP address changed"
      description={
        <>
          <span className="block">
            <span className="font-medium text-foreground">{alert.profileName}:</span> {alert.message}
          </span>
          <span className="mt-2 block">
            Nothing more was sent from that browser.{' '}
            <Link to={historyRunPath(alert.runId)} onClick={dismiss} className="focus-ring rounded text-primary underline-offset-2 hover:underline">
              View the run
            </Link>
          </span>
        </>
      }
      confirmLabel="Launch again"
      cancelLabel="Close"
      onConfirm={() => {
        dismiss()
        navigate('/launch')
      }}
      onCancel={dismiss}
    />
  )
}
