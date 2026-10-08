'use client'
import { useState } from 'react'
import type { FormEvent } from 'react'
export default function Admin() {
  const [token, setToken] = useState(''), [version, setVersion] = useState(''), [files, setFiles] = useState<File[]>([]), [usb, setUsb] = useState<File | null>(null), [online, setOnline] = useState<File | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('Uploading release files…')
    try {
      if (files.length !== 2 || files.some(f => f.size < 1 || f.size > 2 * 1024 ** 3)) throw new Error('Choose exactly two platform files, each under 2 GiB.')
      if (!usb || !online || usb.size > 100000 || online.size > 100000) throw new Error('Choose both signed manifests (maximum 100 KB each).')
      for (const file of files) { const response = await fetch(`/api/admin/uploads/${encodeURIComponent(version)}/${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: file }); if (!response.ok) throw new Error((await response.json()).error || 'Upload failed.') }
      if (!usb || !online) throw new Error('Choose both signed manifests.')
      setMessage('Verifying and publishing…')
      const response = await fetch('/api/admin/releases', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ usb: JSON.parse(await usb.text()), online: JSON.parse(await online.text()) }) })
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Publication failed.')
      setMessage(`Published version ${result.release.version}. Public downloads and the update feed are ready.`)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Operation failed.') } finally { setBusy(false) }
  }
  return <main className="legal section"><span className="eyebrow">RELEASE ADMINISTRATION</span><h1>Publish a verified release.</h1><p>Use the administrator token configured on this server. The token stays in memory; refreshing this page clears it. Both platforms and both publisher-signed manifests are required.</p><form className="admin-form" onSubmit={submit}><label>Administrator token<input type="password" autoComplete="off" required minLength={32} value={token} onChange={e=>setToken(e.target.value)}/></label><label>Release version<input required placeholder="1.3.0" pattern="[0-9]+\.[0-9]+\.[0-9]+" value={version} onChange={e=>setVersion(e.target.value)}/></label><label>Windows EXE and Linux AppImage<input type="file" accept=".exe,.AppImage" multiple required onChange={e=>setFiles(Array.from(e.target.files || []))}/></label><label>Signed USB manifest · Proxy-QA-Browser-Update.json<input type="file" accept=".json" required onChange={e=>setUsb(e.target.files?.[0] || null)}/></label><label>Signed online manifest · update.json<input type="file" accept=".json" required onChange={e=>setOnline(e.target.files?.[0] || null)}/></label><button className="button primary" disabled={busy}>{busy ? 'Publishing…' : 'Upload and publish'}</button><p role="status">{message}</p></form><p>For large files, the documented SSH release upload is resumable. GitHub Actions uses that path automatically.</p></main>
}
