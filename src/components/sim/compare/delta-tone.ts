/** The side the gap falls on: the lap is slower (+, the colour of a loss), faster (-, a gain) or level with the reference. */
export const deltaTone = (seconds: number): 'loss' | 'gain' | 'level' => (seconds > 0.0005 ? 'loss' : seconds < -0.0005 ? 'gain' : 'level');
