window.FrameViewer = function FrameViewer({
  frame,
  frames,
  overlays,
  highlightedElementIds,
  onPrev,
  onNext,
  onToggleAutoplay,
  autoplay,
  onElementSelect
}) {
  const TEXT_VIEWPORT = '\ubdf0\ud3ec\ud2b8';
  const TEXT_FRAME = '\ud504\ub808\uc784';
  const TEXT_EMPTY = '\ud45c\uc2dc\ud560 \ud504\ub808\uc784\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.';
  const TEXT_PREV = '\uc774\uc804';
  const TEXT_NEXT = '\ub2e4\uc74c';
  const TEXT_AUTOPLAY = '\uc790\ub3d9\uc7ac\uc0dd';
  const TEXT_AUTOPLAY_STOP = '\uc790\ub3d9\uc7ac\uc0dd \uc911\uc9c0';
  const TEXT_TOTAL = '\ucd1d';
  const TEXT_SCROLL = '\uc2a4\ud06c\ub864';

  const imgRef = React.useRef(null);
  const scrollRef = React.useRef(null);
  const [imgSize, setImgSize] = React.useState({ w: 1, h: 1, nw: 1, nh: 1 });
  const highlighted = new Set(highlightedElementIds || []);
  const scaleX = imgSize.w / imgSize.nw;
  const scaleY = imgSize.h / imgSize.nh;

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [frame?.id]);

  return (
    <section className="w-full rounded-[28px] border border-white/10 bg-[#0B1320] p-4 shadow-[0_24px_64px_rgba(0,0,0,0.28)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500">{TEXT_VIEWPORT}</div>
          <div className="mt-1 truncate font-semibold text-slate-100">
            {frame ? `${TEXT_FRAME} ${frame.index + 1}` : TEXT_EMPTY}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onPrev} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 hover:bg-white/10">{TEXT_PREV}</button>
          <button type="button" onClick={onToggleAutoplay} className="rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-300/15">
            {autoplay ? TEXT_AUTOPLAY_STOP : TEXT_AUTOPLAY}
          </button>
          <button type="button" onClick={onNext} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 hover:bg-white/10">{TEXT_NEXT}</button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#111826]">
        {frame ? (
          <div ref={scrollRef} className="max-h-[70vh] overflow-auto">
            <div className="relative w-full">
              <img
                ref={imgRef}
                src={`${frame.image}?ts=${Date.now()}`}
                alt={`frame-${frame.index + 1}`}
                className="block h-auto w-full"
                onLoad={e => {
                  const img = e.currentTarget;
                  setImgSize({
                    w: Math.max(1, Math.round(img.clientWidth)),
                    h: Math.max(1, Math.round(img.clientHeight)),
                    nw: img.naturalWidth || 1,
                    nh: img.naturalHeight || 1
                  });
                }}
              />
              {(overlays || []).map(item => {
                const active = highlighted.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={item.text || item.id}
                    onClick={() => onElementSelect(item.id)}
                    className={[
                      'absolute rounded-xl transition',
                      item.type === 'cta' ? 'border border-rose-400/80 bg-rose-400/10' : 'border border-sky-300/70 bg-sky-300/10',
                      active ? 'opacity-100 ring-2 ring-cyan-300 shadow-[0_0_0_1px_rgba(125,211,252,0.45)]' : 'opacity-60'
                    ].join(' ')}
                    style={{
                      left: `${item.x * scaleX}px`,
                      top: `${item.y * scaleY}px`,
                      width: `${Math.max(8, item.width * scaleX)}px`,
                      height: `${Math.max(8, item.height * scaleY)}px`
                    }}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex h-[420px] items-center justify-center text-slate-400">{TEXT_EMPTY}</div>
        )}
      </div>

      {frames?.length ? (
        <div className="mt-3 text-sm text-slate-400">
          {`${TEXT_TOTAL} ${frames.length}\uac1c ${TEXT_FRAME} \uc911 ${TEXT_SCROLL} ${frame?.scrollPercent ?? 0}%`}
        </div>
      ) : null}
    </section>
  );
};
