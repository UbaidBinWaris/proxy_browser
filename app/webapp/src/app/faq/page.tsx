import type { Metadata } from 'next'
import { Inline } from '@/components/Inline'
import { JsonLd } from '@/components/JsonLd'
import { FAQ_CHAPTERS, answerText, faqItems } from '@/lib/faq'
import { faqPage, pageBreadcrumbs, pageMetadata } from '@/lib/seo'
import { CONTACT_EMAILS, FAQ_PATH, REPO_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({
  title: 'FAQ: cost, privacy, proxies and browsers',
  description: 'Answers about Proxy QA Browser in chapters: cost, responsible use, locations and proxies, browsers and devices, automation, privacy, updates and contact.',
  path: FAQ_PATH,
})

export default function FaqPage() {
  const items = faqItems()
  return <>
    <JsonLd data={pageBreadcrumbs('FAQ', FAQ_PATH)} />
    <JsonLd data={faqPage(items.map(item => ({ question: item.question, answer: answerText(item) })))} />
    <header className="page-header">
      <span className="eyebrow">FAQ</span>
      <h1>Frequently asked questions.</h1>
      <p className="page-lead">Short answers about cost, responsible use, locations, browsers, automation, privacy and updates, grouped in chapters. Each answer links to the guide with the details.</p>
    </header>
    <div className="faq-shell">
      <nav className="faq-chapters" aria-label="FAQ chapters">
        <ol>{FAQ_CHAPTERS.map(chapter => <li key={chapter.id}><a href={`#${chapter.id}`}>{chapter.title}<span>{chapter.entries.length}</span></a></li>)}</ol>
      </nav>
      <div className="faq-content">
        {FAQ_CHAPTERS.map(chapter => <section key={chapter.id} id={chapter.id} className="faq-chapter" aria-labelledby={`${chapter.id}-title`}>
          <h2 id={`${chapter.id}-title`}>{chapter.title}</h2>
          <p className="faq-chapter-intro">{chapter.intro}</p>
          {items.filter(item => item.chapter === chapter.id).map(item => <article key={item.id} className="faq-entry" aria-labelledby={item.id}>
            <h3 id={item.id}><a href={`#${item.id}`}>{item.question}</a></h3>
            {item.answer.map(paragraph => <p key={paragraph}><Inline text={paragraph} /></p>)}
            {item.table ? <div className="faq-table"><table>
              <thead><tr>{item.table.head.map((cell, i) => <th key={i} scope="col">{cell}</th>)}</tr></thead>
              <tbody>{item.table.rows.map(row => <tr key={row[0]}>{row.map((cell, i) => i === 0 ? <th key={i} scope="row">{cell}</th> : <td key={i}>{cell}</td>)}</tr>)}</tbody>
            </table></div> : null}
          </article>)}
          {chapter.id === 'contact' ? <aside className="contact-card faq-contact" aria-labelledby="faq-contact-title">
            <h3 id="faq-contact-title">Get in touch</h3>
            <ul>
              {CONTACT_EMAILS.map(contact => <li key={contact.address}><a href={`mailto:${contact.address}`}>{contact.label}: {contact.address}<span>{contact.purpose}</span></a></li>)}
              <li><a href={`${REPO_URL}/issues`} rel="noopener noreferrer">GitHub issues<span>Bug reports and feature requests, in public</span></a></li>
            </ul>
          </aside> : null}
        </section>)}
      </div>
    </div>
  </>
}
