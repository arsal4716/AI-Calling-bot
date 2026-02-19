// src/pages/CallLogs/components/SearchBar.jsx
import React, { useState } from "react";

const SearchBar = ({ onSearch }) => {
  const [input, setInput] = useState("");

  const submit = () => onSearch(input.trim());

  return (
    <div className="mb-4 flex gap-2">
      <input
        type="text"
        placeholder="Search by phone number or Call SID"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        className="w-full border rounded p-2"
      />
      <button
        onClick={submit}
        className="px-4 py-2 rounded bg-indigo-600 text-white text-sm"
      >
        Search
      </button>
    </div>
  );
};

export default React.memo(SearchBar);
