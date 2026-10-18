import { Plus_Jakarta_Sans } from "next/font/google";
import { ThemeToggle } from "../operacion/_components/ThemeToggle";
import { THEME_INIT_SCRIPT } from "../operacion/_components/theme";
import "../operacion/operacion.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", variable: "--font-ops" });

/** El acceso interno (operación y unidades) usa la misma identidad visual y apariencia que la consola. */
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div suppressHydrationWarning className={`ops ${jakarta.variable} relative flex min-h-screen w-full flex-1 flex-col`}>
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <div className="absolute top-4 right-4">
        <ThemeToggle compact />
      </div>
      {children}
    </div>
  );
}
