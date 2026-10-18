import type { Metadata } from "next";
import "./railbet.css";

export const metadata: Metadata = {
  title: "RailBET · O teu palpite vai chegar primeiro",
  description: "Aposta créditos fictícios no atraso dos comboios portugueses. O palpite mais próximo ganha.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-PT">
      <body className="antialiased">{children}</body>
    </html>
  );
}
