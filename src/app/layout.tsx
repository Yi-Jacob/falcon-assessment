import "./globals.css";

export const metadata = {
  title: "Falcon Recon — Exception Review",
  description: "Custodian / Salesforce reconciliation, AUM and exception review workspace.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="app-body">{children}</body>
    </html>
  );
}
