import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Fuente de la marca, solo para el logotipo (.ru-wordmark, en negrita); el resto usa la fuente del sistema.
// Autoalojada por next/font (sin pedidos a Google desde el navegador).
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: "700", variable: "--font-jakarta", display: "swap" });

export const metadata: Metadata = {
  title: "Radar Urbano",
  description: "Reportes ciudadanos de problemas en el espacio público, evaluados y asignados automáticamente.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f4c81",
  colorScheme: "only light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`h-full ${jakarta.variable}`}>
      <body className="min-h-full flex flex-col antialiased">{children}</body>
    </html>
  );
}
