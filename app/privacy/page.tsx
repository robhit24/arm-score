import s from "./privacy.module.css";

export default function Privacy() {
  return (
    <div className={s.page}>
      <div className={s.container}>
        <h1>Privacy Policy</h1>
        <p className={s.updated}>Last updated: March 25, 2026</p>

        <h2>1. Information We Collect</h2>
        <p>We collect the following information when you use ArmIQ AI:</p>
        <ul>
          <li><strong>Email address</strong> — required to use the Service and deliver results</li>
          <li><strong>Video frames</strong> — extracted from your uploaded videos for AI analysis (original videos are not stored)</li>
          <li><strong>Pitch analysis data</strong> — scores, breakdowns, and training plan content</li>
          <li><strong>Age group and sport selection</strong> — used to calibrate analysis</li>
          <li><strong>Payment information</strong> — processed securely by Stripe; we do not store card numbers</li>
          <li><strong>Usage data</strong> — pages visited, features used, collected via Meta Pixel for advertising optimization</li>
        </ul>

        <h2>2. How We Use Your Information</h2>
        <ul>
          <li>To provide and improve the pitch analysis and training plan service</li>
          <li>To send you your analysis results and training plans via email</li>
          <li>To manage your subscription and account</li>
          <li>To send magic link login emails</li>
          <li>To optimize our advertising through Meta Pixel events</li>
          <li>To display anonymized scores on the leaderboard (first initial only, no full names or emails shown)</li>
        </ul>

        <h2>3. Information Sharing</h2>
        <p>We do not sell your personal information. We share data only with:</p>
        <ul>
          <li><strong>OpenAI</strong> — video frames are sent to OpenAI for AI analysis (subject to OpenAI&apos;s privacy policy)</li>
          <li><strong>Stripe</strong> — for payment processing</li>
          <li><strong>Amazon Web Services</strong> — for data storage and email delivery</li>
          <li><strong>Meta</strong> — anonymized conversion events for ad optimization</li>
          <li><strong>Vercel</strong> — for website hosting</li>
        </ul>

        <h2>4. Data Retention</h2>
        <p>We retain your pitch analysis data and account information for as long as your account is active. If you cancel your subscription, your data is retained for 12 months before deletion. You may request deletion of your data at any time by emailing help@hit24.com.</p>

        <h2>5. Data Security</h2>
        <p>We use industry-standard security measures including encrypted connections (HTTPS), secure payment processing (Stripe PCI compliance), and access-controlled databases (AWS DynamoDB). However, no method of transmission over the Internet is 100% secure.</p>

        <h2>6. Children&apos;s Privacy</h2>
        <p>The Service is intended to be used by parents and guardians on behalf of their children. We do not knowingly collect personal information directly from children under 13. All accounts must be created by a parent or guardian. Video uploads of minors are processed only for pitch analysis and are not used for any other purpose.</p>

        <h2>7. Cookies and Tracking</h2>
        <p>We use:</p>
        <ul>
          <li><strong>Session cookies</strong> — to keep you logged in (30-day expiry)</li>
          <li><strong>Meta Pixel</strong> — to track page views, leads, and purchases for advertising optimization</li>
        </ul>
        <p>You can disable cookies in your browser settings, but some features may not work properly.</p>

        <h2>8. Your Rights</h2>
        <p>You have the right to:</p>
        <ul>
          <li>Access your personal data</li>
          <li>Request correction of inaccurate data</li>
          <li>Request deletion of your data</li>
          <li>Opt out of marketing communications</li>
          <li>Request a copy of your data</li>
        </ul>
        <p>To exercise any of these rights, email help@hit24.com.</p>

        <h2>9. California Residents (CCPA)</h2>
        <p>If you are a California resident, you have additional rights under the CCPA including the right to know what personal information is collected, the right to delete, and the right to opt out of the sale of personal information. We do not sell personal information.</p>

        <h2>10. Changes to This Policy</h2>
        <p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated date.</p>

        <h2>11. Contact</h2>
        <p>For privacy questions or data requests, contact us at help@hit24.com.</p>
      </div>
    </div>
  );
}
