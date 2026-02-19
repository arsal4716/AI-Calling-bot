// src/pages/CallLogs/components/SearchBar.jsx
import React, { useState, useCallback, useEffect } from 'react';
import debounce from 'lodash/debounce';

const SearchBar = ({ onSearch }) => {
  const [input, setInput] = useState('');

  const debouncedSearch = useCallback(
    debounce((value) => onSearch(value), 300),
    [onSearch]
  );

  const handleChange = (e) => {
    setInput(e.target.value);
    debouncedSearch(e.target.value);
  };

  useEffect(() => {
    return () => debouncedSearch.cancel();
  }, [debouncedSearch]);

  return (
    <div className="mb-4">
      <input
        type="text"
        placeholder="Search by phone number or Call SID"
        value={input}
        onChange={handleChange}
        className="w-full border rounded p-2"
      />
    </div>
  );
};

export default React.memo(SearchBar);