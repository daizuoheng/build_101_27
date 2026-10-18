import "../operacion/operacion.css";

/** El acceso interno (operación y unidades) usa la misma identidad visual y apariencia que la consola. */
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="ops relative flex min-h-screen w-full flex-1 flex-col">
      {children}
    </div>
  );
}
