// Market brief API · merge the sub-workflow results (Africa brief, US picks, Dangote watch) into one JSON answer for the
// Vercel dashboard.
const pick = (name) => {
  try {
    return $(name).all().map((i) => i.json);
  } catch (e) {
    return [];
  }
};
const africa = pick('Run Africa brief');
const picks = pick('Run stock picks');
const dangote = pick('Run Dangote watch');
const join = (items) => items.map((j) => j.text).filter(Boolean).join('\n\n');
return [
  {
    json: {
      generatedAt: new Date().toISOString(),
      picks: { html: join(picks), data: (picks[0] && picks[0].data) || null },
      africa: { html: join(africa), data: (africa[0] && africa[0].data) || null },
      dangote: { html: join(dangote), data: (dangote[0] && dangote[0].data) || null },
    },
  },
];
