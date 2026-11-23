export const metadata = { title: "Falcon Reconciliation (take-home demo)" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 24, color: "#1a1a1a", maxWidth: 1200 }}>
        <style>{`table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f4f4f4}
        .tag{display:inline-block;padding:1px 6px;border-radius:8px;background:#eef;margin:1px;font-size:12px}.error{background:#fdd}.review{background:#ffe9b8}.info{background:#e6f2e6}
        .warn{background:#fff3cd;padding:8px;border:1px solid #e0c870;margin:8px 0}pre{background:#f6f6f6;padding:8px;overflow:auto;white-space:pre-wrap}button{cursor:pointer}`}</style>
        {children}
      </body>
    </html>
  );
}
