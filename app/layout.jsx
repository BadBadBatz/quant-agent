import './globals.css';

export const metadata = {
  title: 'Quant Agent',
  description: 'Autonomous trading system',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#080808] text-[#e8e8e8]">
        {children}
      </body>
    </html>
  );
}
