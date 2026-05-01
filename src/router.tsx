import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { LibraryScreen } from "@/components/LibraryScreen";
import { PlayerScreen } from "@/components/PlayerScreen";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LibraryScreen,
});

interface PlayerSearch {
  title?: string;
}

const playerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/play/$songId",
  component: PlayerScreen,
  validateSearch: (search: Record<string, unknown>): PlayerSearch => ({
    title: typeof search.title === "string" ? search.title : undefined,
  }),
});

const routeTree = rootRoute.addChildren([libraryRoute, playerRoute]);

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
