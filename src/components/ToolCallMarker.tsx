import { ChevronDownIcon, CircleCheckIcon, CircleXIcon } from "lucide-react"

import type { ToolCall } from "@/chat/api"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { MarkerContent, MarkerIcon, markerVariants } from "@/components/ui/marker"
import { cn } from "@/lib/utils"

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/**
 * One thing the agent did, shown in the room as a status line: what happened,
 * and (on click) the exact input and result, plus any pages a search found.
 */
export function ToolCallMarker({ tool }: { tool: ToolCall }) {
  return (
    <Collapsible className="w-full">
      <CollapsibleTrigger
        className={cn(
          markerVariants(),
          "group/tool cursor-pointer rounded-md px-1 py-0.5 transition-colors hover:text-foreground"
        )}
      >
        <MarkerIcon>
          {tool.isError ? (
            <CircleXIcon className="text-destructive" />
          ) : (
            <CircleCheckIcon className="text-white" />
          )}
        </MarkerIcon>
        <MarkerContent className="flex-1">{tool.output}</MarkerContent>
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open/tool:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-1.5 ml-7 grid gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
          <div className="grid gap-1">
            <dt className="font-medium text-muted-foreground">Input</dt>
            <dd>
              <pre className="font-mono whitespace-pre-wrap">{JSON.stringify(tool.input, null, 2)}</pre>
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="font-medium text-muted-foreground">{tool.isError ? "Error" : "Result"}</dt>
            <dd className={cn(tool.isError && "text-destructive")}>{tool.output}</dd>
          </div>
          {tool.results && tool.results.length > 0 && (
            <div className="grid gap-1">
              <dt className="font-medium text-muted-foreground">Sources</dt>
              <dd>
                <ol className="grid gap-1">
                  {tool.results.map((r) => (
                    <li key={r.url} className="min-w-0">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-w-0 items-baseline gap-1.5 hover:text-foreground"
                      >
                        <span className="truncate underline underline-offset-3">{r.title || r.url}</span>
                        <span className="shrink-0 text-muted-foreground">{hostname(r.url)}</span>
                      </a>
                    </li>
                  ))}
                </ol>
              </dd>
            </div>
          )}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}
