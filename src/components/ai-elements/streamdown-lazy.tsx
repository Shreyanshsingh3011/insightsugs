// Default export so React.lazy can consume it. All heavy deps (streamdown +
// mermaid/katex/shiki via plugins) live in a chunk that only loads in the
// browser, keeping the SSR bundle small.
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const streamdownPlugins = { cjk, code, math, mermaid };

type Props = ComponentProps<typeof Streamdown>;

export default function StreamdownLazy({ className, ...props }: Props) {
  return (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  );
}
