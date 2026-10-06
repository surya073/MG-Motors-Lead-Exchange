import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * useUrlSearch — lets the navbar search open a page already filtered.
 * When the URL carries ?search=..., push that text into the page's own
 * search state (on arrival and whenever the param changes, e.g. when you
 * search again while already on the page). Does nothing when the param
 * is absent, so a page's normal typing/filtering is untouched.
 */
export default function useUrlSearch(setSearch) {
  const { search } = useLocation();

  useEffect(() => {
    const value = new URLSearchParams(search).get("search");
    if (value !== null) setSearch(value);
    // setSearch is a state setter (stable); only the URL should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
}
