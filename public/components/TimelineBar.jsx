window.TimelineBar = function TimelineBar({ frames, selectedIndex, onSelect }) {
  const TEXT_EMPTY = '\ud0c0\uc784\ub77c\uc778 \ud504\ub808\uc784\uc774 \uc544\uc9c1 \uc5c6\uc2b5\ub2c8\ub2e4.';
  const TEXT_FRAME = '\ud504\ub808\uc784';
  const TEXT_SCROLL = '\uc2a4\ud06c\ub864';

  if (!frames || frames.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">
        {TEXT_EMPTY}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex min-w-max gap-3">
        {frames.map(frame => {
          const selected = frame.index === selectedIndex;
          return (
            <button
              key={frame.id}
              type="button"
              onClick={() => onSelect(frame.index)}
              className={[
                'w-[136px] overflow-hidden rounded-2xl border text-left transition',
                selected ? 'border-sky-300 bg-sky-50 shadow-[0_0_0_1px_rgba(56,189,248,0.2)]' : 'border-slate-200 bg-white hover:border-slate-300'
              ].join(' ')}
            >
              <img src={`${frame.image}?ts=${Date.now()}`} alt={`frame-${frame.index + 1}`} className="block h-[76px] w-full object-cover" />
              <div className="p-3">
                <div className="text-xs text-slate-400">{`${TEXT_FRAME} ${frame.index + 1}`}</div>
                <div className="mt-1 text-sm font-medium text-slate-900">{`${TEXT_SCROLL} ${frame.scrollPercent}%`}</div>
                <div className="mt-1 text-[11px] text-slate-500">{frame.scrollY}px</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
