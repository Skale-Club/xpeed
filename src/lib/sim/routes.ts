/** The page of one session. */
export const sessionPath = (id: string) => `/virtual/sessions/${encodeURIComponent(id)}`;
/** The page of one track: its progress, the best lap of each car, its latest sessions. */
export const trackPath = (id: string) => `/virtual/tracks/${encodeURIComponent(id)}`;
/** The page of one car: the best lap on each track and its latest sessions. */
export const carPath = (id: string) => `/virtual/cars/${encodeURIComponent(id)}`;
