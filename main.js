const axios_ = require('axios');
const https = require('https');
const chunk = require('lodash.chunk');
const config = require('./config');

// Waiting for the certificate fullchain to be updated...
const axios = axios_.create({
    baseURL: `https://${config.buckutt.api}/api/v1/`,
    httpsAgent: new https.Agent({  
        rejectUnauthorized: false
    })
});

let token;

axios.interceptors.request.use(config => {
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
});

const embedUsers = encodeURIComponent(JSON.stringify([
    'wallets',
    'memberships'
]));

const fetchERPPages = async (page, contribs) => {
    try {
        const { data } = await axios.get(`http://${config.erp.host}/api/index.php/members?DOLAPIKEY=${config.erp.key}&page=${page}&limit=100`);

        return fetchERPPages(page + 1, contribs.concat(data));
    } catch(err) {
        return contribs;
    }
};

const groupRequests = async (requests, groupSize) => {
    const groupedRequests = chunk(requests, groupSize);
    let promisesResults = [];
    let results;

    for (const reqs of groupedRequests) {
        results = await Promise.all(reqs.map(request => request()));

        promisesResults = promisesResults.concat(results);
    }

    return promisesResults;
};

const process = async () => {
    const credentials = config.buckutt.admin;

    try {
        const { data: login } = await axios.post('auth/login', credentials);

        token = login.token;

        console.log('Logged to the BuckUTT API. Fetching BuckUTT users...');
    } catch {
        console.log('Error: Unable to connect to the BuckUTT API.');
        return;
    }

    let buckuttUsers = [];

    try {
        const { data: users } = await axios.get(`crud/users?embed=${embedUsers}`);

        buckuttUsers = users.map(user => ({
            id: user.id,
            mail: user.mail,
            current: {
                contributor: user.memberships.find(membership => membership.group_id === config.buckutt.contributorGroup && membership.period_id === config.buckutt.defaultPeriod),
                nonContributor: user.memberships.find(membership => membership.group_id === config.buckutt.nonContributorGroup && membership.period_id === config.buckutt.defaultPeriod)
            },
            wallets: user.wallets
        }));

        console.log('BuckUTT users fetched. Fetching ERP users...');
    } catch(err) {
        console.log('Error: Unable to fetch BuckUTT users.');
        return;
    }

    let erpUsers;

    try {
        const users = await fetchERPPages(0, []);

        erpUsers = users.map(etu => ({
            etuId: etu.array_options.options_student ? `22${etu.array_options.options_student.padStart(11, '0')}` : null,
            firstname: etu.firstname,
            lastname: etu.lastname,
            login: etu.login,
            mail: etu.email,
            contributor: ((parseInt(etu.datefin) >= Math.ceil(new Date().getTime() / 1000) && etu.datefin !== '') || etu.need_subscription == 0)
        }));

        console.log('ERP users fetched. Creating users, wallets and memberships...');
    } catch(err) {
        console.log('Error: unable to connect to the ERP.');
        return;
    }

    const usersRequests = [];
    const walletRequests = [];

    erpUsers.forEach(erpUser => {
        const buckuttUserIndex = buckuttUsers.findIndex(bUser => bUser.wallets.find(w => w.logical_id === erpUser.etuId) || bUser.mail === erpUser.mail);
        const buckuttUser = buckuttUsers[buckuttUserIndex];

        if (!buckuttUser) {
            const newUser = {
                firstname: erpUser.firstname,
                lastname: erpUser.lastname,
                pin: 'notGenYet',
                password: 'notGenYet',
                mail: erpUser.mail
            };

            usersRequests.push(() => createUser(newUser, erpUser.etuId, erpUser.contributor));
        } else {
            if (buckuttUser.wallets.length === 0) {
                walletRequests.push(() => createWallet(buckuttUser.id, erpUser.etuId));
            }

            if (buckuttUser.mail !== erpUser.mail) {
                walletRequests.push(() => updateMail(buckuttUser.id, erpUser.mail));
            }

            // We admit that the first created wallet of an user is its main one
            if (buckuttUser.wallets[0] && !buckuttUser.wallets[0].logical_id && erpUser.etuId) {
                walletRequests.push(() => updateWallet(buckuttUser.wallets[0].id, erpUser.etuId));
            }

            buckuttUsers[buckuttUserIndex].isContributor = erpUser.contributor;
        }
    });

    let usersCreated;
    try {
        usersCreated = await groupRequests(usersRequests, 5);
        await groupRequests(walletRequests, 5);

        console.log('Users and wallets created. Creating and removing memberships...');
    } catch(err) {
        console.log('Error: Failed to create and update users');
        return;
    }

    const allUsers = usersCreated.concat(buckuttUsers);
    const membershipRequests = [];

    allUsers.forEach(user => {
        if (user.current.contributor && !user.isContributor) {
            membershipRequests.push(() => removeUserFromGroup(user.current.contributor));
        } else if (!user.current.contributor && user.isContributor) {
            membershipRequests.push(() => addUserToGroup(user.id, config.buckutt.contributorGroup, config.buckutt.defaultPeriod));
        }

        if (!user.current.nonContributor) {
            membershipRequests.push(() => addUserToGroup(user.id, config.buckutt.nonContributorGroup, config.buckutt.defaultPeriod));
        }
    });

    await groupRequests(membershipRequests, 5);

    console.log('Sync done.');
};

const createUser = async (user, logicalId, isContributor) => {
    console.log(`Create user ${user.mail}`);

    const { data: createdUser } = await axios.post('crud/users', user);

    await createWallet(createdUser.id, logicalId);
    
    return {
        id: createdUser.id,
        mail: createdUser.mail,
        current: {
            contributor: false,
            nonContributor: false
        },
        wallets: [],
        isContributor
    };
};

const createWallet = (userId, logicalId) => {
    console.log(`Create wallet of user ${userId}`);

    const newWallet = {
        logical_id: logicalId,
        physical_id: 'Carte étu',
        user_id: userId
    };

    return axios.post('crud/wallets', newWallet);
};

const updateWallet = (walletId, logicalId) => {
    console.log(`Update wallet ${walletId}`);

    return axios.put(`crud/wallets/${walletId}`, { logical_id: logicalId });
};

const updateMail = (userId, mail) => {
    console.log(`Update mail ${mail} of user ${userId}`);

    return axios.put(`crud/users/${userId}`, { mail });
};

const addUserToGroup = (userId, groupId, periodId) => {
    const membership = {
        user_id  : userId,
        group_id : groupId,
        period_id: periodId
    };

    console.log(`Add user ${userId} to group ${groupId} (period ${periodId})`);
    return axios.post('crud/memberships', membership);
};

const removeUserFromGroup = (membership) => {
    console.log(`Remove user ${membership.user_id} from group ${membership.group_id} (period ${membership.period_id})`);
    return axios.delete(`crud/memberships/${membership.id}`);
};

process();
