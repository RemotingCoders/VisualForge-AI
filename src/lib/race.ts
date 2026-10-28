/** Race resolution identical in spirit to the DB unique constraint on round_finds(round_id, difference_id): first valid write wins. */
export class RaceBook {
  private winners = new Map<string, string>();
  claim(roundId: string, differenceId: string, playerId: string): { winner: string; alreadyClaimed: boolean } {
    const key = `${roundId}:${differenceId}`, existing = this.winners.get(key);
    if (existing) return { winner: existing, alreadyClaimed: true };
    this.winners.set(key, playerId); return { winner: playerId, alreadyClaimed: false };
  }
  winnerOf(roundId: string, differenceId: string) { return this.winners.get(`${roundId}:${differenceId}`) ?? null; }
}
export const roomCode = (rand = Math.random) => Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(rand() * 31)]).join('');
