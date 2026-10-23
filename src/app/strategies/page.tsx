import StrategiesExplorer from "./explorer";

type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/**
 * /strategies?cat=<id>&q=<text>&open=<strategy id>
 *
 * The query is read here and handed to the explorer as initial state, so the
 * list is server-rendered instead of arriving as an empty client shell.
 */
export default async function StrategiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  return (
    <StrategiesExplorer
      initialCategory={one(params.cat) ?? null}
      initialQuery={one(params.q) ?? null}
      initialOpen={one(params.open) ?? null}
    />
  );
}
