import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/** The "Load more" button of a list that grows page by page: there is no hidden paging, the person asks for the next page. Renders nothing at the end. */
export function LoadMore({ hasNextPage, isFetchingNextPage, onClick, testId = "load-more" }: { hasNextPage: boolean; isFetchingNextPage: boolean; onClick: () => void; testId?: string }) {
  const { t } = useTranslation();
  if (!hasNextPage) return null;
  return (
    <div className="flex justify-center pt-2">
      <Button variant="outline" onClick={onClick} disabled={isFetchingNextPage} data-testid={testId}>
        {isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden="true" />}
        {t("ui.loadMore.label", "Load more")}
      </Button>
    </div>
  );
}
