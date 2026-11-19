/** 上游署名保留；维护版更新仓库固定，构建参数和用户设置均不能切换来源。 */
export const UPSTREAM_REPOSITORY = 'jxb412/yunqiao.me';
export const UPSTREAM_PROJECT_URL = `https://github.com/${UPSTREAM_REPOSITORY}`;
declare const __YUNQIAO_RELEASE_REPOSITORY__: string;
export const RELEASE_REPOSITORY = typeof __YUNQIAO_RELEASE_REPOSITORY__ === 'string'
  ? __YUNQIAO_RELEASE_REPOSITORY__ : 'erik00000/yunqiao.me';
if (RELEASE_REPOSITORY !== 'erik00000/yunqiao.me') {
  throw new Error('维护版必须使用 erik00000/yunqiao.me GitHub 发布仓库');
}
// 列表包含个人维护版的预发布；/latest 不会返回标记为 prerelease 的发布。
export const GITHUB_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100`;
export const GITHUB_RELEASE_PAGE = `https://github.com/${RELEASE_REPOSITORY}/releases`;
export const OFFICIAL_SITE_ORIGIN = 'https://ai.haowucm.cn';
export const OFFICIAL_CATALOG_URL = `${OFFICIAL_SITE_ORIGIN}/pub.php?action=catalog`;
