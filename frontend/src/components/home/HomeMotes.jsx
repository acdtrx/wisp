/**
 * Stray wisps drifting across the Home canvas — the page's only ambient motion,
 * and the reason the app is called Wisp. Four blurred accent dots on long,
 * unsynchronised loops so the movement never reads as a pattern.
 *
 * Animation classes are spelled out literally: Tailwind scans source text, so a
 * computed class name would emit no CSS. `motion-reduce:animate-none` parks
 * every mote for anyone who asked the OS for less motion.
 */
const MOTES = [
  {
    tint: 'home-mote-teal',
    style: { width: 10, height: 10, top: '22%', left: '12%' },
    animation: 'animate-[wisp-drift-a_26s_ease-in-out_infinite]',
  },
  {
    tint: 'home-mote-pale',
    style: { width: 6, height: 6, top: '58%', left: '78%' },
    animation: 'animate-[wisp-drift-b_32s_ease-in-out_infinite]',
  },
  {
    tint: 'home-mote-teal',
    style: { width: 8, height: 8, top: '78%', left: '34%' },
    animation: 'animate-[wisp-drift-c_24s_ease-in-out_infinite]',
  },
  {
    tint: 'home-mote-pale',
    style: { width: 4, height: 4, top: '36%', left: '55%' },
    animation: 'animate-[wisp-drift-a_38s_ease-in-out_infinite_reverse]',
  },
];

export default function HomeMotes() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {MOTES.map((mote, i) => (
        <span
          key={i}
          style={mote.style}
          className={`absolute rounded-full blur-[6px] ${mote.tint} ${mote.animation} motion-reduce:animate-none`}
        />
      ))}
    </div>
  );
}
