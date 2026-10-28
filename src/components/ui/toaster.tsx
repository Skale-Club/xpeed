import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Level = "default" | "success" | "warning" | "destructive";

// Each level of importance has its icon, colour and time on screen: a confirmation
// goes quickly, a problem stays until it can be read (or until it is closed).
const LEVELS: Record<Level, { icon: typeof Info; color: string; duration: number }> = {
  success: { icon: CheckCircle2, color: "text-success", duration: 3500 },
  default: { icon: Info, color: "text-sky-400", duration: 5000 },
  warning: { icon: AlertTriangle, color: "text-warn", duration: 7000 },
  destructive: { icon: XCircle, color: "text-destructive", duration: 9000 },
};

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider swipeDirection="right">
      {toasts.map(function ({ id, title, description, action, variant, duration, ...props }) {
        const level = LEVELS[(variant ?? "default") as Level] ?? LEVELS.default;
        const Icon = level.icon;
        // With an action (Undo, Try again) there is time to use it.
        const time = duration ?? (action ? Math.max(level.duration, 7000) : level.duration);
        const urgent = variant === "destructive" || variant === "warning";
        return (
          <Toast key={id} variant={variant} duration={time} type={urgent ? "foreground" : "background"} {...props}>
            <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", level.color)} aria-hidden="true" />
            <div className="grid min-w-0 flex-1 gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
              {action}
            </div>
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
