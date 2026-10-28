import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface PageLoaderProps {
  className?: string;
  fullScreen?: boolean;
}

export const PageLoader = ({ className, fullScreen = true }: PageLoaderProps) => {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Only show loader if loading takes more than 150ms to avoid flicker
    const timer = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(timer);
  }, []);

  if (!show) return null;

  return (
    <div className={cn(
      "flex items-center justify-center bg-background",
      fullScreen ? "fixed inset-0 z-50" : "w-full h-full min-h-[200px]",
      className
    )}>
      <div className="flex flex-col items-center gap-2">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t("common.loading", "Loading…")}</p>
      </div>
    </div>
  );
};
