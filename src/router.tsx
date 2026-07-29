// App-wide TanStack Router instance (route tree, default error/pending
// components). Imported once by start.ts/client entry — do not duplicate.

import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
} from "./components/RouterBoundaries";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
    defaultNotFoundComponent: DefaultNotFoundComponent,
  });

  return router;
};
