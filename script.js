const SUPABASE_URL = 'https://mkxbpxehgzcrimjyuomu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reGJweGVoZ3pjcmltanl1b211Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNzg5MDksImV4cCI6MjEwNzY1NDkwOX0.JDt7raDr9XkcyIgQ5KIa0sX-xohW8Q0uxL9A0bMcCUQ';

let supabaseClient = null;
try {
    if (SUPABASE_URL && SUPABASE_URL !== 'YOUR_SUPABASE_URL' && window.supabase) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
} catch (err) {
    console.warn("Supabase initialization skipped. Running in local state mode.", err);
}

let state = {
    roomKey: null,
    username: null,
    isHost: false,
    participants: [],
    polls: [],
    activePollId: null,
    options: [],
    votes: [],
    subscriptions: []
};

let modalResolve = null;

function showCustomPrompt(title, description, defaultValue = "") {
    return new Promise((resolve) => {
        closeAllDropdowns();
        modalResolve = resolve;
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-desc').innerText = description;
        const inputEl = document.getElementById('modal-input');
        inputEl.value = defaultValue;
        
        document.getElementById('custom-modal').classList.add('active');
        setTimeout(() => inputEl.focus(), 100);

        inputEl.onkeydown = (e) => {
            if (e.key === 'Enter') closeModal(true);
        };
    });
}

function closeModal(isSubmitted) {
    const inputEl = document.getElementById('modal-input');
    const val = inputEl.value;
    document.getElementById('custom-modal').classList.remove('active');
    if (modalResolve) {
        modalResolve(isSubmitted ? val : null);
        modalResolve = null;
    }
}

function generateKey() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function toggleDropdown(id) {
    const el = document.getElementById(id);
    const isOpen = el.classList.contains('active');
    closeAllDropdowns();
    if (!isOpen) el.classList.add('active');
}

function closeAllDropdowns() {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
}

window.addEventListener('click', e => { 
    if (!e.target.closest('.nav-item')) {
        closeAllDropdowns();
    }
});

window.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
        let uname = await showCustomPrompt("Join Room", `Enter your username to join room ${roomParam}:`, "Participant");
        if (uname && uname.trim()) joinRoom(roomParam, uname.trim());
    }
});

async function createRoom() {
    closeAllDropdowns();
    let uname = await showCustomPrompt("Create Room", "Enter your username to act as the host:", "HostUser");
    if (!uname || !uname.trim()) return;
    let key = generateKey();

    if (supabaseClient) {
        try {
            await supabaseClient.from('rooms').insert([{ room_key: key }]);
            await supabaseClient.from('participants').insert([{ room_key: key, name: uname.trim(), role: 'Host' }]);
            await supabaseClient.from('polls').insert([{ room_key: key, title: 'Main Poll', status: 'open' }]);
        } catch (e) {
            console.error("Supabase write error, using local fallback:", e);
        }
    }

    state.roomKey = key; 
    state.username = uname.trim(); 
    state.isHost = true;
    state.participants = [{ name: uname.trim(), role: 'Host' }];
    state.polls = [{ id: 1, title: 'Main Poll', status: 'open', result_visibility: 'live' }];
    state.activePollId = 1;
    state.options = [];
    state.votes = [];

    enterRoom(key);
}

async function promptJoinRoom() {
    closeAllDropdowns();
    let key = await showCustomPrompt("Join Room", "Enter the 6-digit Room Key:");
    if (!key || key.trim().length !== 6) {
        if (key !== null) alert("Please enter a valid 6-digit key.");
        return;
    }
    let uname = await showCustomPrompt("Join Room", `Enter your display name to join room ${key.trim()}:`, "Participant");
    if (!uname || !uname.trim()) return;
    
    joinRoom(key.trim(), uname.trim());
}

async function joinRoom(key, uname) {
    state.roomKey = key;
    state.username = uname;
    state.isHost = false;

    if (supabaseClient) {
        try {
            let { data: parts } = await supabaseClient.from('participants').select('*').eq('room_key', key);
            if (parts && parts.length > 0) {
                await supabaseClient.from('participants').upsert([{ room_key: key, name: uname, role: 'Participant' }], { onConflict: 'room_key,name' });
            }
        } catch (e) {
            console.warn("Supabase join error:", e);
        }
    }

    state.participants = [{ name: 'HostUser', role: 'Host' }, { name: uname, role: 'Participant' }];
    state.polls = [{ id: 1, title: 'Main Poll', status: 'open', result_visibility: 'live' }];
    state.activePollId = 1;

    enterRoom(key);
}

async function enterRoom(key) {
    document.getElementById('home-view').classList.remove('active');
    document.getElementById('room-view').classList.add('active');
    document.getElementById('room-key-display').style.display = 'inline-flex';
    document.getElementById('key-value').innerText = key;

    document.querySelectorAll('.host-only').forEach(el => el.style.display = state.isHost ? 'inline-block' : 'none');

    if (supabaseClient) {
        await fetchRoomData();
        setupRealtime(key);
    } else {
        renderMembers();
        renderPollTabs();
        renderOptionsAndResults(state.polls[0]);
    }
}

async function fetchRoomData() {
    if (!supabaseClient) return;
    try {
        let { data: pData } = await supabaseClient.from('participants').select('*').eq('room_key', state.roomKey);
        if (pData && pData.length > 0) state.participants = pData;
        
        let { data: pollData } = await supabaseClient.from('polls').select('*').eq('room_key', state.roomKey);
        if (pollData && pollData.length > 0) {
            state.polls = pollData;
            if (!state.activePollId) state.activePollId = state.polls[0].id;
        }
    } catch (e) {
        console.warn("Fetch error:", e);
    }

    renderMembers();
    renderPollTabs();
    await fetchActivePollDetails();
}

async function fetchActivePollDetails() {
    if (!supabaseClient || !state.activePollId) return;
    let poll = state.polls.find(p => p.id === state.activePollId);
    if (!poll) return;

    document.getElementById('poll-title-heading').innerHTML = `${poll.title} <span class="badge ${poll.status}">${poll.status.toUpperCase()}</span>`;
    document.getElementById('result-visibility-select').value = poll.result_visibility || 'live';
    document.getElementById('poll-deadline-input').value = poll.deadline ? poll.deadline.slice(0, 16) : '';

    try {
        let { data: optData } = await supabaseClient.from('options').select('*').eq('poll_id', state.activePollId);
        state.options = optData || [];

        let { data: voteData } = await supabaseClient.from('votes').select('*').eq('poll_id', state.activePollId);
        state.votes = voteData || [];
    } catch (e) {
        console.warn("Poll details fetch error:", e);
    }

    renderOptionsAndResults(poll);
}

function setupRealtime(key) {
    if (!supabaseClient) return;
    state.subscriptions.forEach(sub => supabaseClient.removeChannel(sub));
    state.subscriptions = [];

    let channel = supabaseClient.channel(`room-live-${key}`)
        .on('postgres_changes', { event: '*', schema: 'public', filter: `room_key=eq.${key}` }, () => fetchRoomData())
        .subscribe();
    state.subscriptions.push(channel);
}

function renderMembers() {
    const tbody = document.getElementById('user-table-body');
    tbody.innerHTML = '';
    state.participants.forEach(p => {
        let tr = document.createElement('tr');
        let nameDisplay = p.role === 'Host' ? `[Host] ${p.name}` : p.name;
        let kickBtn = (state.isHost && p.name !== state.username) ? `<button class="btn btn-danger" style="padding:2px 6px; font-size:0.75rem;" onclick="kickUser('${p.name}')">Kick</button>` : '';
        tr.innerHTML = `<td>${nameDisplay}</td><td><span class="badge ${p.role.toLowerCase()}">${p.role}</span></td><td>${kickBtn}</td>`;
        tbody.appendChild(tr);
    });
}

function renderPollTabs() {
    const container = document.getElementById('poll-tabs-container');
    container.innerHTML = '';
    state.polls.forEach(poll => {
        let btn = document.createElement('button');
        btn.className = `poll-tab ${poll.id === state.activePollId ? 'active' : ''}`;
        btn.innerText = poll.title;
        btn.onclick = () => { 
            state.activePollId = poll.id; 
            if (supabaseClient) fetchActivePollDetails();
            else renderOptionsAndResults(poll);
        };
        container.appendChild(btn);
    });
}

function renderOptionsAndResults(poll) {
    const list = document.getElementById('options-list');
    list.innerHTML = '';

    let counts = {};
    state.options.forEach(o => counts[o.id] = 0);
    state.votes.forEach(v => { if (counts[v.option_id] !== undefined) counts[v.option_id]++; });

    let userVote = state.votes.find(v => v.voter_name === state.username);

    state.options.forEach(opt => {
        let isVoted = userVote && userVote.option_id === opt.id;
        let li = document.createElement('li');
        li.className = `option-item ${isVoted ? 'voted' : ''}`;
        
        let showCount = (poll.result_visibility === 'live' || poll.status === 'closed');
        let countBadge = showCount ? `<strong>(${counts[opt.id] || 0} votes)</strong>` : '';

        li.innerHTML = `
            <span>${opt.text} ${countBadge}</span>
            <div>
                <small style="margin-right:10px;">By: ${opt.addedBy}</small>
                ${poll.status === 'open' ? `<button class="btn ${isVoted ? 'btn-secondary' : 'btn-primary'}" style="padding:4px 8px; font-size:0.8rem;" onclick="castVote(${opt.id})">${isVoted ? 'Change Vote' : 'Vote'}</button>` : ''}
            </div>
        `;
        list.appendChild(li);
    });

    let outcomeBox = document.getElementById('outcome-box');
    if (poll.status === 'closed') {
        let maxVotes = -1;
        let winningOptions = [];
        Object.keys(counts).forEach(id => {
            if (counts[id] > maxVotes) { maxVotes = counts[id]; winningOptions = [id]; }
            else if (counts[id] === maxVotes) { winningOptions.push(id); }
        });
        let winnerTexts = state.options.filter(o => winningOptions.includes(o.id.toString())).map(o => o.text);
        
        if (winningOptions.length === 0 || maxVotes === 0) {
            outcomeBox.innerText = "Voting Closed: No votes were cast.";
        } else if (winningOptions.length > 1) {
            outcomeBox.innerText = `Tie Outcome: ${winnerTexts.join(', ')} (${maxVotes} votes each)`;
        } else {
            outcomeBox.innerText = `Decision Winner: 🎉 ${winnerTexts[0]} (${maxVotes} votes)`;
        }
    } else {
        outcomeBox.innerText = poll.result_visibility === 'hidden' ? "Results are hidden until the host closes the poll." : "Poll is open. Cast or update your vote anytime!";
    }
}

async function addOption() {
    let input = document.getElementById('new-option-input');
    let val = input.value.trim();
    if (!val) return;

    if (supabaseClient) {
        try {
            await supabaseClient.from('options').insert([{ poll_id: state.activePollId, text: val, addedBy: state.username }]);
            fetchActivePollDetails();
        } catch (e) { console.error(e); }
    } else {
        state.options.push({ id: Date.now(), poll_id: state.activePollId, text: val, addedBy: state.username });
        renderOptionsAndResults(state.polls.find(p => p.id === state.activePollId));
    }
    input.value = '';
}

async function castVote(optionId) {
    if (supabaseClient) {
        try {
            await supabaseClient.from('votes').upsert([{ poll_id: state.activePollId, option_id: optionId, voter_name: state.username }], { onConflict: 'poll_id,voter_name' });
            fetchActivePollDetails();
        } catch (e) { console.error(e); }
    } else {
        state.votes = state.votes.filter(v => v.voter_name !== state.username);
        state.votes.push({ poll_id: state.activePollId, option_id: optionId, voter_name: state.username });
        renderOptionsAndResults(state.polls.find(p => p.id === state.activePollId));
    }
}

async function promptCreatePoll() {
    let title = await showCustomPrompt("New Poll", "Enter new poll topic / question:", "Where should we eat?");
    if (!title || !title.trim()) return;

    if (supabaseClient) {
        try {
            await supabaseClient.from('polls').insert([{ room_key: state.roomKey, title: title.trim(), status: 'open' }]);
            fetchRoomData();
        } catch (e) { console.error(e); }
    } else {
        let newPoll = { id: Date.now(), title: title.trim(), status: 'open', result_visibility: 'live' };
        state.polls.push(newPoll);
        state.activePollId = newPoll.id;
        renderPollTabs();
        renderOptionsAndResults(newPoll);
    }
}

async function updatePollSettings() {
    if (!state.isHost) return;
    let visibility = document.getElementById('result-visibility-select').value;
    let deadline = document.getElementById('poll-deadline-input').value || null;
    
    let poll = state.polls.find(p => p.id === state.activePollId);
    if (poll) { poll.result_visibility = visibility; poll.deadline = deadline; }

    if (supabaseClient) {
        try {
            await supabaseClient.from('polls').update({ result_visibility: visibility, deadline: deadline }).eq('id', state.activePollId);
        } catch (e) { console.error(e); }
    }
}

async function closeCurrentPoll() {
    if (!state.isHost) return;
    let poll = state.polls.find(p => p.id === state.activePollId);
    if (poll) poll.status = 'closed';

    if (supabaseClient) {
        try {
            await supabaseClient.from('polls').update({ status: 'closed' }).eq('id', state.activePollId);
            fetchActivePollDetails();
        } catch (e) { console.error(e); }
    } else {
        renderOptionsAndResults(poll);
        document.getElementById('poll-title-heading').innerHTML = `${poll.title} <span class="badge closed">CLOSED</span>`;
    }
}

async function kickUser(name) {
    if (!state.isHost) return;
    if (supabaseClient) {
        try {
            await supabaseClient.from('participants').delete().eq('room_key', state.roomKey).eq('name', name);
            fetchRoomData();
        } catch (e) { console.error(e); }
    } else {
        state.participants = state.participants.filter(p => p.name !== name);
        renderMembers();
    }
}

function copyInviteLink() {
    let link = `${window.location.origin}${window.location.pathname}?room=${state.roomKey}`;
    navigator.clipboard.writeText(link);
    alert("Invite link copied to clipboard!");
}

function goHome() {
    if (supabaseClient) {
        state.subscriptions.forEach(sub => supabaseClient.removeChannel(sub));
    }
    state = { roomKey: null, username: null, isHost: false, participants: [], polls: [], activePollId: null, options: [], votes: [], subscriptions: [] };
    
    document.getElementById('room-view').classList.remove('active');
    document.getElementById('home-view').classList.add('active');
    document.getElementById('room-key-display').style.display = 'none';
    window.history.replaceState({}, document.title, window.location.pathname);
}
// used for error messages
setInterval(() => {
document.getElementById("message").textContent = 
  JSON.stringify(state, null, 2);
}, 100);
