import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of service (template)" };

export default function Terms() {
  return (
    <>
      <h1>Terms of service</h1>
      <p>These terms govern your use of this Atlas instance operated by [Operator name]. Adapt them before publishing.</p>
      <h2>Use of the service</h2>
      <ul>
        <li>You may use Atlas to research publicly available YouTube channel and video information.</li>
        <li>You must not attempt to circumvent rate limits or quota protections, or use Atlas to download videos.</li>
        <li>You are responsible for transcripts you upload and must have the right to upload them.</li>
      </ul>
      <h2>YouTube</h2>
      <p>Atlas uses YouTube API Services and is not affiliated with or endorsed by YouTube. Your use is also subject to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>.</p>
      <h2>Availability and liability</h2>
      <p>[Operator-specific warranty disclaimers, limitation of liability, governing law.]</p>
      <h2>Changes</h2>
      <p>[How users are notified about changes to these terms.]</p>
    </>
  );
}
