import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomic } from './persistence/database.js';
import { identifier, safePath } from './operations/files.js';

/** Only explicit graph purges enqueue IDs. Never enumerate user projects or
 * infer orphan ownership. Retain failed entries across restarts for retry. */
export class GraphFiles {
  private pending:Promise<{removed:number;failed:number}>|undefined;
  constructor(readonly db:DatabaseSync,readonly runsDirectory:string){}
  drain():Promise<{removed:number;failed:number}>{
    if(this.db.isTransaction)throw new Error('Run file cleanup must follow transaction commit');
    if(this.pending)return this.pending;
    this.pending=this.work().finally(()=>{this.pending=undefined;});return this.pending;
  }
  private async work():Promise<{removed:number;failed:number}>{
    const counts={removed:0,failed:0},lease=randomUUID();
    const acquired=atomic(this.db,()=>{
      if(this.db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='backup'").get())return false;
      this.db.prepare("INSERT INTO resource_maintenance_leases VALUES(?,'drain',?)").run(lease,Date.now());return true;
    });
    if(!acquired)return counts;
    try{
      for(const row of this.db.prepare('SELECT run_id FROM run_file_deletions WHERE completed=0').all()){
        try{
          const id=identifier(String(row['run_id']));
          if(this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(id))throw new Error('Run is still retained');
          // Every parent and the target must be free of symlinks. rm never
          // follows nested symlinks; it unlinks those directory entries only.
          const root=await safePath(this.runsDirectory);
          const target=await safePath(join(root,id),true);
          await rm(target,{recursive:true,force:true});
          atomic(this.db,()=>this.db.prepare('UPDATE run_file_deletions SET completed=1 WHERE run_id=?').run(id));counts.removed++;
        }catch{counts.failed++;}
      }
      return counts;
    }finally{atomic(this.db,()=>this.db.prepare('DELETE FROM resource_maintenance_leases WHERE id=?').run(lease));}
  }
}
