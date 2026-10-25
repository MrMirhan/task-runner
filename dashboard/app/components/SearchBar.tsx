"use client";

import { useState } from "react";

interface Props {
  onSearch: (query: string) => void;
  status: string | null;
}

export default function SearchBar({ onSearch, status }: Props) {
  const [value, setValue] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSearch(value.trim());
  }

  function clear() {
    setValue("");
    onSearch("");
  }

  return (
    <form onSubmit={submit} role="search" className="order-last flex min-w-0 basis-full items-center gap-2 md:order-none md:flex-1 md:basis-0">
      <label htmlFor="graph-search" className="sr-only">
        Search the knowledge graph
      </label>
      <input
        id="graph-search"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search entities and facts"
        className="field min-w-0 max-w-md flex-1"
      />
      <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
        Search
      </button>
      {value && (
        <button type="button" onClick={clear} className="btn">
          Clear
        </button>
      )}
      <span role="status" className="truncate text-xs text-muted">
        {status}
      </span>
    </form>
  );
}
