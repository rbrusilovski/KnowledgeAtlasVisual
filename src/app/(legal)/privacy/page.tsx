import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy (template)" };

export default function Privacy() {
  return (
    <>
      <h1>Privacy policy</h1>
      <p>[Operator name] runs this instance of Atlas. This template describes what the software stores; adapt it to your deployment and jurisdiction.</p>
      <h2>What we store</h2>
      <ul>
        <li>Account data: name, email, hashed password or OAuth account identifiers, sessions.</li>
        <li>Your workspace content: collections, notes, tags, saved views, pinned graph layouts, discovery queries.</li>
        <li>Transcripts you upload, and — if you connect a YouTube channel you own — captions from that channel (OAuth tokens are encrypted at rest).</li>
        <li>Public YouTube data obtained through the YouTube Data API (channel and video metadata and statistics).</li>
      </ul>
      <h2>YouTube API Services</h2>
      <p>Atlas uses YouTube API Services. By using Atlas you also agree to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a> and the <a href="https://policies.google.com/privacy">Google Privacy Policy</a>. YouTube data is refreshed or deleted within 30 days. You can revoke Atlas&apos;s access to your Google account at <a href="https://security.google.com/settings/security/permissions">Google security settings</a>.</p>
      <h2>Your rights</h2>
      <p>Export all your data or delete your account at any time from Settings. Deletion removes your personal data immediately; disconnecting YouTube deletes the captions obtained through it.</p>
      <h2>Contact</h2>
      <p>[Contact email / postal address]</p>
    </>
  );
}
